import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWTVerifyGetKey } from "jose";
import type { FastifyInstance } from "fastify";
import { fixture, demoConfig, azureConfig, chat, newModel, principal, agent, fakeCloud } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { loadConfig, validateMcpTarget } from "../src/config.js";
import { mcpPolicy, boundedJson } from "../src/cloud.js";
import { verifySchema } from "../src/migrations.js";

let f: Awaited<ReturnType<typeof fixture>>;
let app: FastifyInstance;
let azure: FastifyInstance;
let keys: JWTVerifyGetKey;
let privateKey: CryptoKey;
const config = azureConfig();

before(async () => {
  f = await fixture();
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] });
  app = await buildApp({ config: demoConfig(), db: f.db, now: f.now, closeDatabase: false, serveStatic: false });
  azure = await buildApp({ config, db: f.db, now: f.now, closeDatabase: false, serveStatic: false, keys, cloud: fakeCloud });
});
beforeEach(async () => f.reset());
after(async () => { await app.close(); await azure.close(); await f.db.close(); });

async function token(overrides: Record<string, unknown> = {}, gateway = false) {
  const defaults = gateway
    ? { oid: config.apimPrincipalId, tid: config.tenantId, idtyp: "app", appid: "88888888-8888-4888-8888-888888888888", roles: ["Gateway.Invoke"] }
    : { oid: principal.id, tid: config.tenantId, scp: "Gateway.Access", roles: ["Gateway.Admin", "Gateway.User", "Gateway.Reader"] };
  return new SignJWT({ ...defaults, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(`https://login.microsoftonline.com/${config.tenantId}/v2.0`)
    .setAudience(gateway ? config.gatewayAudience : config.apiAudience)
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
}
const inferenceHeaders = async () => ({
  authorization: `Bearer ${await token()}`,
  "x-gateway-authorization": `Bearer ${await token({}, true)}`, "x-team-id": "demo-engineering",
});
async function appToken(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ oid: agent.id, tid: config.tenantId, azp: agent.clientAppId, idtyp: "app", roles: ["Gateway.Agent"], ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(`https://login.microsoftonline.com/${config.tenantId}/v2.0`)
    .setAudience(config.apiAudience)
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
}
const registerAgent = async () => {
  const t = (await f.store.teams()).find(team => team.id === "demo-engineering")!;
  await f.store.saveTeam({ id: t.id, name: t.name, monthlyBudgetMicros: t.monthlyBudgetMicros, allowedModels: t.allowedModels,
    principals: t.principals, applications: [agent.id] }, principal.id, true);
};

test("config, health, readiness, and fake session follow portal contract", async () => {
  assert.equal((await app.inject("/healthz")).statusCode, 200);
  assert.equal((await app.inject("/readyz")).statusCode, 200);
  const cfg = (await app.inject("/api/config")).json();
  assert.equal(cfg.mode, "demo");
  assert.deepEqual(Object.keys(cfg.auth).sort(), ["apiScope", "clientId", "tenantId"]);
  const session = (await app.inject("/api/session")).json();
  assert.equal(session.user.id, principal.id);
  assert.ok(session.user.name.includes("FAKE"));
  for (const path of ["teams", "models", "usage", "audit", "mcp-servers"]) {
    const result = await app.inject(`/api/${path}`);
    assert.equal(result.statusCode, 200);
    assert.ok(Array.isArray(result.json().items));
  }
});

test("demo startup rejects production and non-loopback; requests reject remote host, address, proxy", async () => {
  for (const env of [{ NODE_ENV: "production" }, { HOST: "0.0.0.0" }, { HOST: "10.0.0.1" }]) {
    assert.throws(() => loadConfig({ ...env, GATEWAY_MODE: "demo" }));
  }
  assert.equal((await app.inject({ url: "/api/config", headers: { host: "evil.example" } })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/config", remoteAddress: "192.0.2.1" })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/config", headers: { "x-forwarded-for": "127.0.0.1" } })).statusCode, 403);
});

test("CORS allows known dev origin only, with no wildcard", async () => {
  const good = await app.inject({ url: "/api/config", headers: { origin: "http://localhost:5173" } });
  assert.equal(good.statusCode, 200);
  assert.equal(good.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal((await app.inject({ url: "/api/config", headers: { origin: "https://evil.example" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "OPTIONS", url: "/api/teams", headers: { origin: "http://127.0.0.1:5173" } })).statusCode, 204);
});

test("Azure configuration requires verified PostgreSQL TLS and distinct v2 audiences", () => {
  for (const suffix of ["", "?sslmode=disable", "?sslmode=require", "?sslmode=no-verify",
    "?sslmode=verify-full&sslmode=disable", "?sslmode=verify-full&ssl=false"]) {
    assert.throws(() => azureConfig({ DATABASE_URL: `postgresql://test@localhost/test${suffix}` }));
  }
  assert.doesNotThrow(() => azureConfig());
  assert.throws(() => azureConfig({ GATEWAY_API_AUDIENCE: config.apiAudience }));
  assert.throws(() => azureConfig({ GATEWAY_API_AUDIENCE: `api://${config.gatewayAudience}` }));
});

test("production schema verification is read-only and readiness rejects incompatible schemas", async () => {
  await verifySchema(f.db);
  await f.db.query("INSERT INTO gateway_migrations(version) VALUES (999)");
  try {
    await assert.rejects(verifySchema(f.db));
    assert.equal((await app.inject("/readyz")).statusCode, 503);
    const versions = await f.db.query<{ version: number }>("SELECT version FROM gateway_migrations ORDER BY version");
    assert.deepEqual(versions.map(row => row.version), [1, 2, 999]);
  } finally {
    await f.db.query("DELETE FROM gateway_migrations WHERE version=999");
  }
});

test("mutations validate all fields and reject unsafe, negative, zero-price, unknown options", async () => {
  const team = { id: "created", name: "Created", monthlyBudgetMicros: 1000, allowedModels: ["demo-chat"], principals: [principal.id] };
  assert.equal((await app.inject({ method: "POST", url: "/api/teams", payload: team })).statusCode, 201);
  assert.equal((await app.inject({ method: "POST", url: "/api/teams", payload: team })).statusCode, 409);
  for (const payload of [{ ...team, id: "../bad" }, { ...team, monthlyBudgetMicros: -1 },
    { ...team, monthlyBudgetMicros: Number.MAX_SAFE_INTEGER + 1 }, { ...team, principals: ["admin"] },
    { ...team, override: true }, { ...team, id: "unknown-model-team", allowedModels: ["unknown"] }]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/teams", payload })).statusCode, 400);
  }
  for (const payload of [{ ...newModel, inputPriceMicrosPerMillion: 0 }, { ...newModel, outputPriceMicrosPerMillion: -1 },
    { ...newModel, capacity: 0 }, { ...newModel, contextWindowTokens: 100 }, { ...newModel, pricingValidUntil: "2020-01-01T00:00:00Z" }]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/models", payload })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/models", payload: newModel })).statusCode, 201);
});

test("plain OpenAI completion and playground both settle through shared ledger", async () => {
  const result = await app.inject({ method: "POST", url: "/openai/v1/chat/completions", headers: { "x-team-id": "demo-engineering" }, payload: chat });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().object, "chat.completion");
  assert.ok(result.json().choices[0].message.content.includes("SIMULATED"));
  assert.ok(Number(result.headers["x-gateway-charged-micros"]) > 0);
  const play = await app.inject({ method: "POST", url: "/api/playground/chat",
    payload: { teamId: "demo-engineering", modelId: "demo-chat", messages: chat.messages, maxCompletionTokens: 32 } });
  assert.equal(play.statusCode, 200);
  assert.ok(play.json().usage.chargedMicros > 0);
  assert.equal((await f.store.usage()).length, 2);
  assert.ok((await f.store.usage()).every(u => u.status === "settled"));
});

test("unsupported payloads, idempotency keys, malformed IDs and body bounds reject before reserve", async () => {
  for (const extra of [{ stream: true }, { tools: [] }, { n: 2 }, { max_tokens: 32 }, { temperature: 1 },
    { modalities: ["audio"] }, { usage: { total_tokens: 0 } }, { cost: 0 }]) {
    const result = await app.inject({ method: "POST", url: "/openai/v1/chat/completions", headers: { "x-team-id": "demo-engineering" }, payload: { ...chat, ...extra } });
    assert.equal(result.statusCode, 400);
  }
  assert.equal((await app.inject({ method: "POST", url: "/openai/v1/chat/completions", headers: { "x-team-id": "demo-engineering" },
    payload: { ...chat, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://evil.example" } }] }] } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/openai/v1/chat/completions", headers: { "x-team-id": "demo-engineering", "idempotency-key": "key" }, payload: chat })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/openai/v1/chat/completions", headers: { "x-team-id": "../other" }, payload: chat })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/openai/v1/chat/completions", headers: { "x-team-id": "demo-engineering" },
    payload: { ...chat, messages: [{ role: "user", content: "A".repeat(300_000) }] } })).statusCode, 413);
  assert.equal((await f.store.usage()).length, 0);
});

test("Azure auth rejects unsigned/missing/app-only user tokens, wrong tenant and wrong role", async () => {
  assert.equal((await azure.inject("/api/teams")).statusCode, 401);
  assert.equal((await azure.inject({ url: "/api/teams", headers: { authorization: "Bearer bogus" } })).statusCode, 401);
  for (const claims of [{ tid: "99999999-9999-4999-8999-999999999999" }, { scp: "" }, { idtyp: "app" }]) {
    assert.equal((await azure.inject({ url: "/api/teams", headers: { authorization: `Bearer ${await token(claims)}` } })).statusCode, 401);
  }
  assert.equal((await azure.inject({ url: "/api/overview", headers: { authorization: `Bearer ${await token({ roles: ["Gateway.User"] })}` } })).statusCode, 403);
  assert.equal((await azure.inject({ method: "POST", url: "/api/models", headers: { authorization: `Bearer ${await token({ roles: ["Gateway.Reader"] })}` }, payload: newModel })).statusCode, 403);
});

test("user-only catalogs are scoped to membership without ARM access or peer principal disclosure", async () => {
  const colleague = "99999999-9999-4999-8999-999999999999";
  for (const team of await f.store.teams()) {
    await f.store.saveTeam({
      id: team.id, name: team.name, monthlyBudgetMicros: team.monthlyBudgetMicros,
      allowedModels: team.allowedModels,
      principals: team.id === "demo-engineering" ? [principal.id, colleague] : [colleague],
    }, principal.id, true);
  }
  await f.store.createModel(newModel, principal.id, "Succeeded");
  const local = await buildApp({ config, db: f.db, now: f.now, keys, closeDatabase: false, serveStatic: false,
    cloud: { ...fakeCloud, deployments: async () => { assert.fail("User catalogs must not enumerate ARM"); } } });
  const headers = { authorization: `Bearer ${await token({ roles: ["Gateway.User"] })}` };
  try {
    const teams = await local.inject({ url: "/api/teams", headers });
    assert.equal(teams.statusCode, 200);
    assert.deepEqual(teams.json().items.map((team: { id: string }) => team.id), ["demo-engineering"]);
    assert.deepEqual(teams.json().items[0].principals, [principal.id]);
    const models = await local.inject({ url: "/api/models", headers });
    assert.equal(models.statusCode, 200);
    assert.deepEqual(models.json().items.map((model: { id: string }) => model.id), ["demo-chat"]);
    for (const path of ["/api/overview", "/api/audit", "/api/usage", "/api/mcp-servers"]) {
      assert.equal((await local.inject({ url: path, headers })).statusCode, 403);
    }
  } finally { await local.close(); }
});

test("Azure inference requires separate valid APIM app proof and principal team membership", async () => {
  const headers = await inferenceHeaders();
  assert.equal((await azure.inject({ method: "POST", url: "/openai/v1/chat/completions", headers: { authorization: headers.authorization, "x-team-id": "demo-engineering" }, payload: chat })).statusCode, 401);
  assert.equal((await azure.inject({ method: "POST", url: "/openai/v1/chat/completions", headers: { ...headers, "x-gateway-authorization": headers.authorization }, payload: chat })).statusCode, 401);
  for (const claims of [{ oid: principal.id }, { scp: "Gateway.Access" }, { roles: ["Gateway.Admin"] }]) {
    assert.equal((await azure.inject({ method: "POST", url: "/openai/v1/chat/completions",
      headers: { ...headers, "x-gateway-authorization": `Bearer ${await token(claims, true)}` }, payload: chat })).statusCode, 403);
  }
  assert.equal((await azure.inject({ method: "POST", url: "/openai/v1/chat/completions",
    headers: { ...headers, authorization: `Bearer ${await token({ oid: "99999999-9999-4999-8999-999999999999" })}` }, payload: chat })).statusCode, 403);
  assert.equal((await azure.inject({ method: "POST", url: "/openai/v1/chat/completions", headers, payload: chat })).statusCode, 200);
  assert.equal((await azure.inject({ url: "/mcp-tools/budget", headers })).statusCode, 200);
  assert.equal((await azure.inject({ url: "/mcp-tools/models", headers: { authorization: headers.authorization } })).statusCode, 401);
});

test("Azure model creation persists asynchronous state and never claims success on failures", async () => {
  const headers = { authorization: `Bearer ${await token()}` };
  const result = await azure.inject({ method: "POST", url: "/api/models", headers, payload: newModel });
  assert.equal(result.statusCode, 202);
  assert.equal(result.json().status, "Creating");
  const failed = await buildApp({ config, db: f.db, keys, closeDatabase: false, serveStatic: false,
    cloud: { ...fakeCloud, createDeployment: async () => { throw new Error("Azure failed"); } } });
  try {
    const error = await failed.inject({ method: "POST", url: "/api/models", headers,
      payload: { ...newModel, id: "failed-model", deploymentName: "failed-model" } });
    assert.equal(error.statusCode, 503);
    assert.equal((await f.store.models()).find(m => m.id === "failed-model")!.status, "Unknown");
  } finally { await failed.close(); }
});

test("Azure playground forwards user authorization to APIM and never invokes direct provider", async () => {
  let forwarded = false;
  const local = await buildApp({ config, db: f.db, keys, closeDatabase: false, serveStatic: false,
    cloud: { ...fakeCloud, infer: async () => { assert.fail("must not bypass APIM"); },
      playground: async (input, teamId, authorization) => {
        assert.equal(input.model, "demo-chat");
        assert.equal(teamId, "demo-engineering");
        assert.ok(authorization.startsWith("Bearer "));
        forwarded = true;
        return fakeCloud.playground(input, teamId, authorization);
      } } });
  try {
    const result = await local.inject({ method: "POST", url: "/api/playground/chat",
      headers: { authorization: `Bearer ${await token()}` },
      payload: { teamId: "demo-engineering", modelId: "demo-chat", messages: chat.messages, maxCompletionTokens: 32 } });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().usage.chargedMicros, 42);
    assert.equal(forwarded, true);
  } finally { await local.close(); }
});

test("unpriced inventory is disabled until explicitly governed", async () => {
  await f.store.importDeployment({ name: "discovered", modelName: "gpt-4o", modelVersion: "2024-08-06",
    status: "Succeeded", sku: "Standard", capacity: 1, format: "OpenAI" });
  const imported = (await f.store.models()).find(m => m.id === "discovered")!;
  assert.equal(imported.enabled, false);
  assert.equal(imported.inputPriceMicrosPerMillion, 0);
  assert.equal(imported.contextWindowTokens, 0);
});

const verifiedPricing = {
  displayName: newModel.displayName, inputPriceMicrosPerMillion: newModel.inputPriceMicrosPerMillion,
  outputPriceMicrosPerMillion: newModel.outputPriceMicrosPerMillion, contextWindowTokens: newModel.contextWindowTokens,
  maxOutputTokens: newModel.maxOutputTokens, pricingValidUntil: newModel.pricingValidUntil, enabled: true,
};

test("provisioned or non-OpenAI inventory cannot be enabled under token-priced admission", async () => {
  for (const [name, sku, format] of [
    ["provisioned", "ProvisionedManaged", "OpenAI"],
    ["partner", "Standard", "Partner"],
    ["unknown-sku", "unknown", "OpenAI"],
  ]) {
    await f.store.importDeployment({ name: name!, modelName: "test-model", modelVersion: "1", status: "Succeeded",
      sku: sku!, capacity: 1, format: format! });
    const imported = (await f.store.models()).find(model => model.id === name)!;
    assert.equal(imported.enabled, false);
    assert.equal(imported.sku, sku);
    const result = await app.inject({ method: "PUT", url: `/api/models/${name}`, payload: verifiedPricing });
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error.code, "UNSUPPORTED_DEPLOYMENT");
  }
});

test("deployment version drift invalidates old prices and requires explicit fresh governance", async () => {
  await f.store.createModel(newModel, principal.id, "Succeeded");
  await f.store.importDeployment({
    name: newModel.deploymentName, modelName: newModel.modelName, modelVersion: "next-version",
    status: "Succeeded", sku: newModel.sku, capacity: newModel.capacity, format: "OpenAI",
  });
  const changed = (await f.store.models()).find(model => model.id === newModel.id)!;
  assert.equal(changed.modelVersion, "next-version");
  assert.equal(changed.enabled, false);
  assert.equal(changed.inputPriceMicrosPerMillion, 0);
  assert.equal(changed.contextWindowTokens, 0);
  const result = await app.inject({ method: "PUT", url: `/api/models/${newModel.id}`, payload: verifiedPricing });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().modelVersion, "next-version");
  assert.equal(result.json().enabled, true);
  assert.ok((await f.store.audits()).some(event => event.action === "model.inventory_drift"));
});

test("inventory drift preserves an in-flight pricing snapshot and original reservation", async () => {
  const reservation = await f.ledger.reserve("demo-engineering", principal.id, chat);
  await f.store.importDeployment({
    name: "demo-chat", modelName: "gpt-4.1", modelVersion: "new-version",
    status: "Succeeded", sku: "GlobalStandard", capacity: 4, format: "OpenAI",
  });
  const changed = (await f.store.models())[0]!;
  assert.equal(changed.modelName, "gpt-4.1");
  assert.equal(changed.sku, "GlobalStandard");
  assert.equal(changed.enabled, false);
  assert.equal(changed.inputPriceMicrosPerMillion, 0);
  const settled = await f.ledger.settle(reservation.id, { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
  assert.equal(settled.chargedMicros, 8);
  assert.equal((await f.store.teams())[0]!.spentMicros, 8);
});

test("inventory refresh never clears quarantine or allows governance to release held funds", async () => {
  const reservation = await f.ledger.reserve("demo-engineering", principal.id, chat);
  await assert.rejects(f.ledger.settle(reservation.id, { prompt_tokens: 1, completion_tokens: 1000, total_tokens: 1001 }));
  await f.store.importDeployment({
    name: "demo-chat", modelName: "gpt-4.1", modelVersion: "new-version",
    status: "Succeeded", sku: "GlobalStandard", capacity: 4, format: "OpenAI",
  });
  const changed = (await f.store.models())[0]!;
  assert.equal(changed.quarantined, true);
  assert.equal(changed.status, "quarantined");
  assert.equal(changed.enabled, false);
  assert.equal(changed.modelVersion, "new-version");
  const result = await app.inject({ method: "PUT", url: "/api/models/demo-chat", payload: verifiedPricing });
  assert.equal(result.statusCode, 409);
  assert.equal(result.json().error.code, "MODEL_QUARANTINED");
  assert.equal((await f.store.teams())[0]!.reservedMicros, Number(reservation.reserved));
});

test("MCP target guards forbid SSRF and credential-stealing audience/path variants", async () => {
  for (const url of ["http://tools.example.com/mcp", "https://localhost/mcp", "https://127.0.0.1/mcp",
    "https://169.254.169.254/metadata", "https://tools.example.com.evil.example/mcp",
    "https://user:password@tools.example.com/mcp", "https://tools.example.com/mcp?redirect=evil",
    "https://tools.example.com/%2fadmin", "https://tools.example.com:8443/mcp"]) {
    assert.throws(() => validateMcpTarget(config, url, "api://trusted-tools"));
  }
  assert.throws(() => validateMcpTarget(config, "https://tools.example.com/mcp", "https://graph.microsoft.com"));
  const input = { id: "safe-tools", name: "Trusted tools", path: "mcp/safe-tools", backendUrl: "https://tools.example.com/mcp", authAudience: "api://trusted-tools" };
  const policy = mcpPolicy(config, input);
  assert.ok(policy.includes('follow-redirects="false"'));
  assert.ok(policy.includes("validate-jwt"));
  assert.ok(policy.includes('resource="api://trusted-tools"'));
  assert.ok(!policy.includes("<retry"));
  const result = await azure.inject({ method: "POST", url: "/api/mcp-servers", headers: { authorization: `Bearer ${await token()}` }, payload: input });
  assert.equal(result.statusCode, 202);
  assert.equal(result.json().toolCostsCovered, false);
  assert.equal((await azure.inject({ method: "POST", url: "/api/mcp-servers",
    headers: { authorization: `Bearer ${await token()}` }, payload: { ...input, id: "collision", path: "mcp/governance" } })).statusCode, 400);
  assert.equal((await azure.inject({ method: "POST", url: "/api/mcp-servers",
    headers: { authorization: `Bearer ${await token()}` }, payload: { ...input, id: "bad", authType: "apiKey", password: "never" } })).statusCode, 400);
});

test("bounded upstream reader prevents excessive response allocation", async () => {
  await assert.rejects(boundedJson(new Response("x".repeat(100), { headers: { "content-length": "100" } }), 10));
  await assert.rejects(boundedJson(new Response("x".repeat(100)), 10));
});

test("audit contains actor and metadata, never prompt or response content", async () => {
  const secret = "NEVER_STORE_THIS_PROMPT";
  await app.inject({ method: "POST", url: "/openai/v1/chat/completions", headers: { "x-team-id": "demo-engineering" },
    payload: { ...chat, messages: [{ role: "user", content: secret }] } });
  const data = JSON.stringify({ audits: await f.store.audits(), usage: await f.store.usage() });
  assert.ok(!data.includes(secret));
  assert.ok(!data.includes("SIMULATED"));
  assert.ok(data.includes(principal.id));
});

test("app-only agent tokens with Gateway.Agent reach inference and tools through APIM proof, scoped to their team", async () => {
  await registerAgent();
  const proof = `Bearer ${await token({}, true)}`;
  const call = async (authorization: string, team = "demo-engineering", gateway: string | null = proof) =>
    azure.inject({ method: "POST", url: "/openai/v1/chat/completions", payload: chat,
      headers: { authorization, "x-team-id": team, ...(gateway ? { "x-gateway-authorization": gateway } : {}) } });
  const ok = await call(`Bearer ${await appToken()}`);
  assert.equal(ok.statusCode, 200, ok.body);
  // v1-style appid is accepted as the client application ID when azp is absent.
  assert.equal((await call(`Bearer ${await appToken({ azp: undefined, appid: agent.clientAppId })}`)).statusCode, 200);
  const usage = (await f.store.usage()).filter(u => u.actorType === "app");
  assert.equal(usage.length, 2);
  assert.ok(usage.every(u => u.actorId === agent.id && u.clientAppId === agent.clientAppId && u.status === "settled"));
  const budget = await azure.inject({ url: "/mcp-tools/budget", headers: { authorization: `Bearer ${await appToken()}`, "x-gateway-authorization": proof } });
  assert.equal(budget.statusCode, 200);
  assert.deepEqual(budget.json().items.map((t: { id: string }) => t.id), ["demo-engineering"]);
  assert.deepEqual([budget.json().items[0].principals, budget.json().items[0].applications], [[], [agent.id]]);
  const models = await azure.inject({ url: "/mcp-tools/models", headers: { authorization: `Bearer ${await appToken()}`, "x-gateway-authorization": proof } });
  assert.deepEqual(models.json().items.map((m: { id: string }) => m.id), ["demo-chat"]);
});

test("app-only tokens are rejected without the role, without a mapped team, without APIM proof, or on portal routes", async () => {
  await registerAgent();
  const proof = `Bearer ${await token({}, true)}`;
  const call = async (authorization: string, team = "demo-engineering", gateway: string | null = proof) =>
    azure.inject({ method: "POST", url: "/openai/v1/chat/completions", payload: chat,
      headers: { authorization, "x-team-id": team, ...(gateway ? { "x-gateway-authorization": gateway } : {}) } });
  for (const roles of [[], ["Gateway.User"], ["Gateway.Admin", "Gateway.Reader"]]) {
    const denied = await call(`Bearer ${await appToken({ roles })}`);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, "APP_ROLE_REQUIRED");
  }
  const unmapped = await call(`Bearer ${await appToken()}`, "demo-research");
  assert.equal(unmapped.statusCode, 403);
  assert.equal(unmapped.json().error.code, "TEAM_ACCESS_DENIED");
  const stranger = await call(`Bearer ${await appToken({ oid: "99999999-9999-4999-8999-999999999999" })}`);
  assert.equal(stranger.json().error.code, "TEAM_ACCESS_DENIED");
  assert.equal((await call(`Bearer ${await appToken()}`, "demo-engineering", null)).statusCode, 401);
  for (const claims of [{ azp: undefined }, { azp: "not-a-guid" }, { idtyp: "user" }, { oid: config.apimPrincipalId },
    { tid: "99999999-9999-4999-8999-999999999999" }]) {
    assert.equal((await call(`Bearer ${await appToken(claims)}`)).statusCode, 401, JSON.stringify(claims));
  }
  const app = `Bearer ${await appToken()}`;
  for (const url of ["/api/session", "/api/teams", "/api/models", "/api/usage"]) {
    const rejected = await azure.inject({ url, headers: { authorization: app } });
    assert.equal(rejected.statusCode, 401, url);
    assert.equal(rejected.json().error.code, "USER_TOKEN_REQUIRED");
  }
  assert.equal((await azure.inject({ method: "POST", url: "/api/playground/chat", headers: { authorization: app },
    payload: { teamId: "demo-engineering", modelId: "demo-chat", messages: chat.messages, maxCompletionTokens: 32 } })).statusCode, 401);
  // Gateway.Agent is an application permission; a delegated user token carrying it gains nothing.
  assert.equal((await call(`Bearer ${await token({ roles: ["Gateway.Agent"] })}`)).statusCode, 403);
  assert.equal((await f.store.usage()).length, 0);
});

test("demo mode simulates an app-only agent offline with ledger attribution and team mapping", async () => {
  const session = (await app.inject("/api/session")).json();
  assert.equal(session.user.type, "user");
  assert.equal(session.demoAgent.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const agentCall = (team: string) => app.inject({ method: "POST", url: "/openai/v1/chat/completions",
    headers: { "x-team-id": team, "x-demo-caller": "app" }, payload: chat });
  assert.equal((await agentCall("demo-engineering")).statusCode, 200);
  const denied = await agentCall("demo-research");
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "TEAM_ACCESS_DENIED");
  const play = await app.inject({ method: "POST", url: "/api/playground/chat",
    payload: { teamId: "demo-engineering", modelId: "demo-chat", messages: chat.messages, maxCompletionTokens: 32, simulateAgent: true } });
  assert.equal(play.statusCode, 200);
  const usage = await f.store.usage();
  assert.equal(usage.length, 2);
  assert.ok(usage.every(u => u.actorType === "app" && u.actorId === session.demoAgent.id && u.clientAppId === session.demoAgent.clientAppId));
  // The demo header never elevates portal routes, and agent simulation is refused outside the demo.
  assert.equal((await app.inject({ url: "/api/session", headers: { "x-demo-caller": "app" } })).json().user.type, "user");
  const cloudPlay = await azure.inject({ method: "POST", url: "/api/playground/chat", headers: { authorization: `Bearer ${await token()}` },
    payload: { teamId: "demo-engineering", modelId: "demo-chat", messages: chat.messages, maxCompletionTokens: 32, simulateAgent: true } });
  assert.equal(cloudPlay.statusCode, 400);
  assert.equal(cloudPlay.json().error.code, "DEMO_ONLY");
});

test("external MCP policy admits delegated users with scope or app-only Gateway.Agent callers only", () => {
  const policy = mcpPolicy(config, { id: "safe-tools", name: "Trusted tools", path: "mcp/safe-tools",
    backendUrl: "https://tools.example.com/mcp", authAudience: "api://trusted-tools" });
  assert.ok(policy.includes("<value>Gateway.Agent</value>"));
  assert.ok(policy.includes("Contains(&quot;Gateway.Access&quot;)"));
  assert.ok(policy.includes("roles.Contains(&quot;Gateway.Agent&quot;)"));
  assert.ok(policy.includes('<set-header name="Authorization" exists-action="delete" />'));
  assert.ok(!policy.includes('name="scp"'), "scp is checked per caller type, not required for app-only tokens");
  assert.throws(() => mcpPolicy(azureConfig({ ENTRA_API_SCOPE: 'api://x/bad"scope' }), {
    id: "safe-tools", name: "Trusted tools", path: "mcp/safe-tools", backendUrl: "https://tools.example.com/mcp", authAudience: "api://trusted-tools" }));
});