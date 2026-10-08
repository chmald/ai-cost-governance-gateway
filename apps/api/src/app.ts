import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { JWTVerifyGetKey } from "jose";
import { Auth, DEMO_AGENT, role } from "./auth.js";
import { AzureCloud, type Cloud } from "./cloud.js";
import { webRoot, validateMcpTarget, type Config } from "./config.js";
import type { Database } from "./db.js";
import { fail, GatewayError, operationalError, safeNumber } from "./errors.js";
import { Inference, providerResponse } from "./inference.js";
import { Ledger } from "./ledger.js";
import { Store, month } from "./store.js";
import { verifySchema } from "./migrations.js";
import { AGENT_ROLE, identifier, completion, playground, teamCreate, teamFields, modelCreate, modelFields, mcpCreate, type Principal } from "./schemas.js";

declare module "fastify" {
  interface FastifyRequest { principal: Principal | null }
}

export type AppOptions = {
  config: Config; db: Database; now?: () => Date; cloud?: Cloud; keys?: JWTVerifyGetKey;
  closeDatabase?: boolean; serveStatic?: boolean;
};

export async function buildApp(options: AppOptions) {
  const { config, db } = options;
  const app = Fastify({
    logger: false, trustProxy: false,
    bodyLimit: 262_144, requestTimeout: 90_000, connectionTimeout: 90_000,
    routerOptions: { maxParamLength: 128 }, onProtoPoisoning: "error", onConstructorPoisoning: "error",
  });
  const store = new Store(db, options.now);
  const ledger = new Ledger(db, options.now);
  const cloud = config.mode === "azure" ? options.cloud ?? new AzureCloud(config) : undefined;
  const inference = new Inference(ledger, cloud);
  const auth = new Auth(config, options.keys);
  app.decorateRequest("principal", null);

  app.addHook("onRequest", async (request, reply) => {
    auth.checkLocal(request);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cache-Control", "no-store");
    const origin = request.headers.origin;
    if (origin) {
      const sameOrigin = `${config.mode === "azure" ? "https" : request.protocol}://${request.headers.host}`;
      const allowedDev = config.mode === "demo" && [
        "http://127.0.0.1:5173", "http://localhost:5173",
        `http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, `http://[::1]:${config.port}`,
      ].includes(origin);
      if (origin !== sameOrigin && !allowedDev) fail(403, "ORIGIN_REJECTED", "Cross-origin access is not allowed.");
      reply.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      if (!origin) fail(400, "ORIGIN_REQUIRED", "Preflight requires an origin.");
      reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
        .header("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Team-Id")
        .code(204).send();
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (/^\/(?:api|openai|mcp-tools)(?:\/|$)/.test(request.url) &&
        (typeof payload === "string" || Buffer.isBuffer(payload)) && Buffer.byteLength(payload) > 2_000_000) {
      reply.code(503).header("Content-Type", "application/json").removeHeader("content-length");
      return JSON.stringify({ error: { code: "RESPONSE_LIMIT", message: "Response exceeds the configured safety limit." } });
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GatewayError) {
      if (error.status >= 500) operationalError("gateway.request", error.code, request.id);
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Request contains invalid, missing, unsafe, or unsupported fields." } });
    const err = error as { code?: string; statusCode?: number };
    if (err.code === "23505") return reply.code(409).send({ error: { code: "ALREADY_EXISTS", message: "The resource identifier or path already exists." } });
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: "INVALID_REQUEST", message: "Request could not be accepted." } });
    }
    operationalError("gateway.request", "SERVICE_UNAVAILABLE", request.id);
    return reply.code(503).send({ error: { code: "SERVICE_UNAVAILABLE", message: "Durable storage or a required service is unavailable. Check usage for any in-flight inference before retrying." } });
  });

  // allowApp admits app-only (Gateway.Agent) callers on data-plane routes; portal/admin routes stay user-only.
  const authorize = (roles: string[], gateway = false, allowApp = false) => async (request: FastifyRequest) => {
    request.principal = await auth.caller(request, { allowApp });
    role(request.principal, roles);
    if (gateway) await auth.gateway(request);
  };
  const read = authorize(["Gateway.Reader", "Gateway.Admin"]);
  const catalog = authorize(["Gateway.Reader", "Gateway.User", "Gateway.Admin"]);
  const admin = authorize(["Gateway.Admin"]);
  const infer = authorize(["Gateway.User", "Gateway.Admin", AGENT_ROLE], true, true);
  const tools = authorize(["Gateway.Reader", "Gateway.User", "Gateway.Admin", AGENT_ROLE], true, true);
  const id = (request: FastifyRequest) => identifier.parse((request.params as { id: unknown }).id);
  const actor = (request: FastifyRequest) => request.principal!.id;
  const caller = (request: FastifyRequest) => ({ id: request.principal!.id, type: request.principal!.type });
  const canReadAll = (request: FastifyRequest) => request.principal!.roles.some(r => ["Gateway.Reader", "Gateway.Admin"].includes(r));
  // Scoped views never disclose peer members or other registered applications.
  const scopedTeams = async (request: FastifyRequest) =>
    (await store.teams(caller(request))).map(team => request.principal!.type === "app"
      ? { ...team, principals: [], applications: [actor(request)] }
      : { ...team, principals: [actor(request)], applications: [] });
  const scopedModels = async (request: FastifyRequest) => {
    const allowed = new Set((await store.teams(caller(request))).flatMap(team => team.allowedModels));
    return (await store.models()).filter(model => model.enabled && !model.quarantined && allowed.has(model.id));
  };

  app.get("/healthz", async () => ({ status: "ok", mode: config.mode }));
  app.get("/readyz", async (request, reply) => {
    try {
      await verifySchema(db);
      return { status: "ready", mode: config.mode };
    } catch {
      operationalError("gateway.readiness", "SCHEMA_OR_DATABASE_UNAVAILABLE", request.id);
      return reply.code(503).send({ error: { code: "NOT_READY", message: "Durable database is not ready." } });
    }
  });
  app.get("/api/config", async () => ({
    mode: config.mode,
    auth: { tenantId: config.tenantId, clientId: config.spaClientId, apiScope: config.apiScope },
  }));
  app.get("/api/session", { preHandler: async r => { r.principal = await auth.user(r); } },
    async r => ({ user: r.principal, mode: config.mode,
      ...(config.mode === "demo" ? { demoAgent: { id: DEMO_AGENT.id, name: DEMO_AGENT.name, clientAppId: DEMO_AGENT.clientAppId } } : {}) }));
  app.get("/api/overview", { preHandler: read }, async () => {
    const [teams, deployments, mcpServers] = await Promise.all([store.teams(), store.models(), store.mcpServers()]);
    const sum = (field: "monthlyBudgetMicros" | "spentMicros" | "reservedMicros") =>
      safeNumber(teams.reduce((n, t) => n + BigInt(t[field]), 0n));
    return {
      period: month(options.now?.()), teams: teams.length, deployments: deployments.length, mcpServers: mcpServers.length,
      budgetMicros: sum("monthlyBudgetMicros"), spentMicros: sum("spentMicros"), reservedMicros: sum("reservedMicros"),
    };
  });
  app.get("/api/teams", { preHandler: catalog }, async request =>
    ({ items: canReadAll(request) ? await store.teams() : await scopedTeams(request) }));
  app.post("/api/teams", { preHandler: admin }, async (r, reply) => {
    const result = await store.saveTeam(teamCreate.parse(r.body), actor(r));
    return reply.code(201).send(result);
  });
  app.put("/api/teams/:id", { preHandler: admin }, async r =>
    store.saveTeam({ ...teamFields.parse(r.body), id: id(r) }, actor(r), true));
  app.get("/api/models", { preHandler: catalog }, async request => {
    if (!canReadAll(request)) return { items: await scopedModels(request) };
    if (cloud) for (const deployment of await cloud.deployments()) await store.importDeployment(deployment);
    return { items: await store.models() };
  });
  app.post("/api/models", { preHandler: admin }, async (r, reply) => {
    const input = modelCreate.parse(r.body);
    let model = await store.createModel(input, actor(r), cloud ? "Creating" : "demo");
    if (cloud) {
      try {
        const status = await cloud.createDeployment(input);
        await store.modelStatus(input.id, status, actor(r));
        model = { ...model, status };
      } catch (error) {
        await store.modelStatus(input.id, "Unknown", actor(r));
        throw error;
      }
    }
    return reply.code(cloud ? 202 : 201).send(model);
  });
  app.put("/api/models/:id", { preHandler: admin }, async r =>
    store.updateModel(id(r), modelFields.parse(r.body), actor(r)));
  app.get("/api/mcp-servers", { preHandler: read }, async () => {
    if (cloud) {
      for (const server of await store.mcpServers()) {
        if (["Succeeded", "Failed", "demo"].includes(server.status)) continue;
        const status = await cloud.pollMcp(server);
        if (status !== server.status) await store.mcpStatus(server.id, status, "system");
      }
    }
    return { items: await store.mcpServers() };
  });
  app.post("/api/mcp-servers", { preHandler: admin }, async (r, reply) => {
    const input = mcpCreate.parse(r.body);
    validateMcpTarget(config, input.backendUrl, input.authAudience);
    let server = await store.createMcp(input, actor(r), cloud ? "Creating" : "demo");
    if (cloud) {
      try {
        const status = await cloud.registerMcp(input);
        await store.mcpStatus(input.id, status, actor(r));
        server = { ...server, status };
      } catch (error) {
        await store.mcpStatus(input.id, "Unknown", actor(r));
        throw error;
      }
    }
    return reply.code(cloud ? 202 : 201).send(server);
  });
  app.get("/api/usage", { preHandler: read }, async () => ({ items: await store.usage() }));
  app.get("/api/audit", { preHandler: read }, async () => ({ items: await store.audits() }));

  function noReplay(request: FastifyRequest) {
    if (request.headers["idempotency-key"] || request.headers["x-idempotency-key"]) {
      fail(400, "IDEMPOTENCY_NOT_SUPPORTED", "Idempotency/replay keys are not supported. Inference is never automatically retried.");
    }
    if (Object.keys(request.query as object).length) fail(400, "UNSUPPORTED_QUERY", "Inference query options are not supported.");
  }
  app.post("/openai/v1/chat/completions", { preHandler: infer }, async (r, reply) => {
    noReplay(r);
    const team = identifier.parse(r.headers["x-team-id"]);
    const input = completion.parse(r.body);
    const result = await inference.execute(team, r.principal!, input);
    reply.header("X-Gateway-Charged-Micros", String(result.settled.chargedMicros));
    reply.header("X-Gateway-Reservation-Id", result.reservationId);
    return result.response;
  });
  app.post("/api/playground/chat", { preHandler: authorize(["Gateway.User", "Gateway.Admin"]) }, async r => {
    noReplay(r);
    const input = playground.parse(r.body);
    const chat = { model: input.modelId, messages: input.messages, max_completion_tokens: input.maxCompletionTokens };
    if (input.simulateAgent && cloud) {
      fail(400, "DEMO_ONLY", "Agent simulation is available only in the local demo. Real agents call APIM with their own app-only token.");
    }
    if (cloud) {
      // The portal never calls Foundry: APIM supplies its separate proof to the shared inference route.
      const result = await cloud.playground(chat, input.teamId, r.headers.authorization!);
      const parsed = providerResponse.safeParse(result.response);
      if (!parsed.success) fail(502, "GATEWAY_OUTCOME_UNCERTAIN", "APIM response failed verification. A reservation may remain held; check usage and do not automatically retry.");
      const response = parsed.data;
      return { id: response.id, content: response.choices[0]!.message.content, usage: {
        promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens, chargedMicros: result.chargedMicros,
      } };
    }
    const result = await inference.execute(input.teamId, input.simulateAgent ? DEMO_AGENT : r.principal!, chat);
    return { id: result.response.id, content: result.response.choices[0]!.message.content, usage: result.settled };
  });
  app.get("/mcp-tools/models", { preHandler: tools }, async r => {
    return { items: await scopedModels(r) };
  });
  app.get("/mcp-tools/budget", { preHandler: tools }, async r => ({ items: await scopedTeams(r) }));

  if (options.serveStatic !== false && existsSync(join(webRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false, index: "index.html" });
    app.setNotFoundHandler((r, reply) => {
      if (r.method === "GET" && !/^\/(?:api|openai|mcp-tools|healthz|readyz)(?:\/|$)/.test(r.url) && !r.url.includes(".")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found." } });
    });
  } else {
    app.setNotFoundHandler((_r, reply) => reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found." } }));
  }
  if (options.closeDatabase !== false) app.addHook("onClose", async () => db.close());
  return app;
}
