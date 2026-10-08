import { ManagedIdentityCredential } from "@azure/identity";
import { z } from "zod";
import type { Config } from "./config.js";
import { validateMcpTarget } from "./config.js";
import { fail, GatewayError } from "./errors.js";
import { identifier, mcpCreate, type ChatInput, type DeploymentInventory, type McpInput, type ModelInput } from "./schemas.js";

export type Fetcher = typeof fetch;
export interface Cloud {
  infer(input: ChatInput, deployment: string): Promise<unknown>;
  playground(input: ChatInput, teamId: string, authorization: string): Promise<{ response: unknown; chargedMicros: number }>;
  createDeployment(input: ModelInput): Promise<string>;
  deployments(): Promise<DeploymentInventory[]>;
  registerMcp(input: McpInput): Promise<string>;
  pollMcp(input: McpInput): Promise<string>;
}

export async function boundedJson(response: Response, maximum = 2_000_000, allowEmpty = false): Promise<unknown> {
  if (Number(response.headers.get("content-length") || 0) > maximum) {
    await response.body?.cancel();
    throw new Error("Upstream response exceeds limit.");
  }
  if (!response.body) {
    if (allowEmpty) return {};
    throw new Error("Upstream response missing.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximum) throw new Error("Upstream response exceeds limit.");
      chunks.push(result.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (allowEmpty && bytes === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const xml = (value: string) => value.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));

export function mcpPolicy(config: Config, input: McpInput): string {
  const target = validateMcpTarget(config, input.backendUrl, input.authAudience);
  const scope = config.apiScope.slice(config.apiScope.lastIndexOf("/") + 1);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(scope)) fail(500, "CONFIG_INVALID", "ENTRA_API_SCOPE must end in a simple scope name.");
  // Delegated users need the gateway scope plus a user role; app-only callers (managed identities,
  // service principals, agent identities) need no scp and the Gateway.Agent application role.
  const callerType = `@{
      var jwt = (Jwt)context.Variables["mcp-caller"];
      var roles = jwt.Claims.ContainsKey("roles") ? jwt.Claims["roles"] : new string[0];
      var scp = jwt.Claims.GetValueOrDefault("scp", "");
      var idtyp = jwt.Claims.GetValueOrDefault("idtyp", "");
      if (string.IsNullOrEmpty(jwt.Claims.GetValueOrDefault("oid", ""))) { return "invalid"; }
      if (scp.Length > 0) {
        return idtyp != "app" && scp.Split(' ').Contains("${scope}") && (roles.Contains("Gateway.User") || roles.Contains("Gateway.Admin")) ? "user" : "invalid";
      }
      return (idtyp == "" || idtyp == "app") && roles.Contains("Gateway.Agent") ? "app" : "invalid";
    }`;
  return `<policies>
  <inbound>
    <validate-jwt header-name="Authorization" require-scheme="Bearer" require-expiration-time="true" require-signed-tokens="true" failed-validation-httpcode="401" output-token-variable-name="mcp-caller">
      <openid-config url="https://login.microsoftonline.com/${xml(config.tenantId)}/v2.0/.well-known/openid-configuration" />
      <audiences><audience>${xml(config.apiAudience)}</audience></audiences>
      <issuers><issuer>https://login.microsoftonline.com/${xml(config.tenantId)}/v2.0</issuer></issuers>
      <required-claims>
        <claim name="tid"><value>${xml(config.tenantId)}</value></claim>
        <claim name="roles" match="any"><value>Gateway.User</value><value>Gateway.Admin</value><value>Gateway.Agent</value></claim>
      </required-claims>
    </validate-jwt>
    <set-variable name="mcp-caller-type" value="${xml(callerType)}" />
    <choose>
      <when condition="@((string)context.Variables[&quot;mcp-caller-type&quot;] == &quot;invalid&quot;)">
        <return-response><set-status code="403" reason="Delegated user or Gateway.Agent application required" /></return-response>
      </when>
    </choose>
    <rate-limit-by-key calls="60" renewal-period="60" counter-key="@(((Jwt)context.Variables[&quot;mcp-caller&quot;]).Claims.GetValueOrDefault(&quot;oid&quot;,&quot;unknown&quot;))" />
    <set-header name="X-Gateway-Authorization" exists-action="delete" />
    <set-header name="Authorization" exists-action="delete" />
    <set-backend-service base-url="${xml(target.origin)}" />
    <authentication-managed-identity resource="${xml(input.authAudience)}" ignore-error="false" />
  </inbound>
  <backend><forward-request timeout="60" follow-redirects="false" buffer-request-body="false" buffer-response="false" /></backend>
  <outbound />
  <on-error />
</policies>`;
}

export class AzureCloud implements Cloud {
  private credential: { getToken(scope: string): Promise<{ token: string } | null> };
  constructor(private config: Config, private fetcher: Fetcher = fetch,
    credential?: { getToken(scope: string): Promise<{ token: string } | null> }) {
    this.credential = credential ?? (config.managedIdentityClientId
      ? new ManagedIdentityCredential({ clientId: config.managedIdentityClientId })
      : new ManagedIdentityCredential());
  }
  private async token(scope: string): Promise<string> {
    const token = await this.credential.getToken(scope);
    if (!token) return fail(503, "MANAGED_IDENTITY_UNAVAILABLE", "Managed identity authentication is unavailable.");
    return token.token;
  }
  private accountPath(): string {
    const c = this.config;
    return `/subscriptions/${c.subscriptionId}/resourceGroups/${encodeURIComponent(c.foundryResourceGroup)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(c.foundryAccountName)}/deployments`;
  }
  private apiPath(id: string): string {
    const c = this.config;
    return `/subscriptions/${c.subscriptionId}/resourceGroups/${encodeURIComponent(c.apimResourceGroup)}/providers/Microsoft.ApiManagement/service/${encodeURIComponent(c.apimServiceName)}/apis/external-mcp-${encodeURIComponent(identifier.parse(id))}`;
  }
  private async arm(path: string, method = "GET", body?: unknown, create = false) {
    const response = await this.fetcher(`https://management.azure.com${path}`, {
      method, headers: { Authorization: `Bearer ${await this.token("https://management.azure.com/.default")}`,
        "Content-Type": "application/json", ...(method === "PUT" ? create ? { "If-None-Match": "*" } : { "If-Match": "*" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return fail(502, "AZURE_CONTROL_PLANE_FAILED", `Azure control-plane request failed (HTTP ${response.status}); no success is assumed.`);
    }
    return { status: response.status, body: await boundedJson(response, 2_000_000, true) };
  }
  async infer(input: ChatInput, deployment: string): Promise<unknown> {
    const url = new URL("openai/v1/chat/completions", this.config.foundryEndpoint);
    const response = await this.fetcher(url, {
      method: "POST", headers: { Authorization: `Bearer ${await this.token("https://cognitiveservices.azure.com/.default")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, model: deployment }),
      signal: AbortSignal.timeout(60_000), redirect: "error",
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Inference outcome is uncertain."); }
    return boundedJson(response);
  }
  async playground(input: ChatInput, teamId: string, authorization: string): Promise<{ response: unknown; chargedMicros: number }> {
    const base = this.config.apimGatewayUrl.replace(/\/$/, "");
    let response: Response;
    try {
      response = await this.fetcher(`${base}/openai/v1/chat/completions`, {
        method: "POST", headers: { Authorization: authorization, "X-Team-Id": teamId, "Content-Type": "application/json" },
        body: JSON.stringify(input), signal: AbortSignal.timeout(75_000), redirect: "error",
      });
    } catch {
      return fail(502, "GATEWAY_OUTCOME_UNCERTAIN", "APIM request outcome is uncertain. A reservation may remain held; check usage and do not automatically retry.");
    }
    let body: unknown;
    try { body = await boundedJson(response); } catch {
      return fail(502, "GATEWAY_OUTCOME_UNCERTAIN", "APIM response was invalid. A reservation may remain held; check usage and do not automatically retry.");
    }
    if (!response.ok) {
      const upstream = z.object({ error: z.object({ code: z.string().max(80), message: z.string().max(500) }) }).safeParse(body);
      if (upstream.success) throw new GatewayError(response.status, upstream.data.error.code, upstream.data.error.message);
      return fail(502, "GATEWAY_REQUEST_FAILED", "APIM rejected the request. Check usage for held reservations before retrying.");
    }
    const charge = response.headers.get("x-gateway-charged-micros");
    if (!charge || !/^\d+$/.test(charge) || !Number.isSafeInteger(Number(charge))) {
      return fail(502, "GATEWAY_OUTCOME_UNCERTAIN", "APIM response lacks verified ledger settlement metadata. Check usage; do not automatically retry.");
    }
    return { response: body, chargedMicros: Number(charge) };
  }
  async createDeployment(input: ModelInput): Promise<string> {
    const { status, body } = await this.arm(`${this.accountPath()}/${encodeURIComponent(input.deploymentName)}?api-version=2025-06-01`, "PUT", {
      sku: { name: input.sku, capacity: input.capacity },
      properties: { model: { format: "OpenAI", name: input.modelName, version: input.modelVersion }, versionUpgradeOption: "NoAutoUpgrade" },
    }, true);
    const parsed = z.object({ properties: z.object({ provisioningState: z.string().optional() }).optional() }).parse(body);
    return parsed.properties?.provisioningState ?? (status === 202 ? "Creating" : "Provisioning");
  }
  async deployments() {
    const results: DeploymentInventory[] = [];
    let path = `${this.accountPath()}?api-version=2025-06-01`;
    for (let page = 0; page < 10; page++) {
      const response = await this.arm(path);
      const data = z.object({
        value: z.array(z.object({
          name: identifier,
          sku: z.object({ name: z.string().max(80), capacity: z.number().int().nonnegative().max(100_000).optional() }).optional(),
          properties: z.object({
            provisioningState: z.string().max(80),
            model: z.object({ name: z.string().max(120), version: z.string().max(120).optional(), format: z.string().max(80).optional() }),
          }),
        })).max(1000), nextLink: z.string().optional(),
      }).parse(response.body);
      for (const d of data.value) results.push({
        name: d.name, modelName: d.properties.model.name, modelVersion: d.properties.model.version || "unknown",
        status: d.properties.provisioningState, sku: d.sku?.name ?? "unknown",
        capacity: d.sku?.capacity ?? 0, format: d.properties.model.format ?? "unknown",
      });
      if (!data.nextLink) return results;
      const next = new URL(data.nextLink);
      if (next.origin !== "https://management.azure.com" || next.pathname !== this.accountPath()) fail(502, "INVALID_ARM_RESPONSE", "Unexpected inventory continuation URL.");
      path = next.pathname + next.search;
    }
    return fail(502, "INVENTORY_LIMIT", "Deployment inventory exceeds the bounded page limit.");
  }
  private mcpBody(input: McpInput, locked: boolean) {
    const target = validateMcpTarget(this.config, input.backendUrl, input.authAudience);
    return { properties: {
      displayName: input.name, path: input.path, protocols: ["https"], type: "mcp",
      serviceUrl: target.origin, subscriptionRequired: locked,
      description: "External MCP tool charges are not covered by the model-cost ledger.",
      mcpProperties: { transportType: "streamable", endpoints: [{ name: "message", uriTemplate: target.pathname }] },
    } };
  }
  async registerMcp(input: McpInput): Promise<string> {
    input = mcpCreate.parse(input);
    validateMcpTarget(this.config, input.backendUrl, input.authAudience);
    await this.arm(`${this.apiPath(input.id)}?api-version=2025-09-01-preview`, "PUT", this.mcpBody(input, true), true);
    return this.pollMcp(input);
  }
  async pollMcp(input: McpInput): Promise<string> {
    input = mcpCreate.parse({ id: input.id, name: input.name, path: input.path,
      backendUrl: input.backendUrl, authAudience: input.authAudience });
    validateMcpTarget(this.config, input.backendUrl, input.authAudience);
    const path = this.apiPath(input.id);
    const response = await this.arm(`${path}?api-version=2025-09-01-preview`);
    const state = z.object({ properties: z.object({ provisioningState: z.string().optional() }) }).parse(response.body).properties.provisioningState;
    if (state && !["Succeeded", "Created"].includes(state)) return state;
    // The API stays subscription-locked until its complete security policy is installed.
    await this.arm(`${path}/policies/policy?api-version=2025-09-01-preview`, "PUT", {
      properties: { format: "rawxml", value: mcpPolicy(this.config, input) },
    });
    const enabled = await this.arm(`${path}?api-version=2025-09-01-preview`, "PUT", this.mcpBody(input, false));
    return enabled.status === 202 ? "Securing" : "Succeeded";
  }
}
