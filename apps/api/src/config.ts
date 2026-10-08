import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { config as dotenv } from "dotenv";
import { z } from "zod";
import { fail } from "./errors.js";
import { validateDatabaseAuth, type DatabaseAuth } from "./database-auth.js";

export const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
export const loopbackHost = (host: string) => ["127.0.0.1", "::1", "[::1]", "localhost"].includes(host.toLowerCase());
export const loopbackAddress = (address: string) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);

export type Config = {
  mode: "demo" | "azure"; host: string; port: number; databaseUrl: string; databaseAuth: DatabaseAuth;
  tenantId: string; spaClientId: string; apiAudience: string; apiScope: string;
  gatewayAudience: string; apimPrincipalId: string; subscriptionId: string;
  foundryResourceGroup: string; foundryAccountName: string; foundryEndpoint: string;
  apimResourceGroup: string; apimServiceName: string; apimGatewayUrl: string;
  mcpAllowedHosts: string[]; mcpAllowedAudiences: string[]; managedIdentityClientId?: string;
};

function httpsUrl(raw: string, label: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return fail(500, "CONFIG_INVALID", `${label} must be an HTTPS URL.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
    (url.port && url.port !== "443") || isIP(url.hostname) || loopbackHost(url.hostname)) {
    fail(500, "CONFIG_INVALID", `${label} must be a fixed public HTTPS URL without credentials, query, or fragment.`);
  }
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = z.enum(["demo", "azure"]).parse(env.GATEWAY_MODE || "demo");
  const host = env.HOST || "127.0.0.1";
  if (mode === "demo" && (env.NODE_ENV === "production" || !loopbackHost(host))) {
    fail(500, "DEMO_LOCAL_ONLY", "Demo is forbidden in production and must bind a loopback host.");
  }
  const required = (key: string) => {
    const value = env[key]?.trim() || "";
    if (mode === "azure" && !value) fail(500, "CONFIG_MISSING", `${key} is required in Azure mode.`);
    return value;
  };
  const databaseUrl = env.DATABASE_URL || "pglite://data/gateway";
  const databaseAuth = env.DATABASE_AUTH ?? "password";
  if (databaseAuth !== "password" && databaseAuth !== "entra") {
    fail(500, "CONFIG_INVALID", "DATABASE_AUTH must be password or entra.");
  }
  validateDatabaseAuth(databaseUrl, { databaseAuth, mode, managedIdentityClientId: env.AZURE_CLIENT_ID });
  if (mode === "azure" && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    fail(500, "CONFIG_INVALID", "Azure mode requires durable PostgreSQL DATABASE_URL; embedded fallback is forbidden.");
  }
  if (!/^(pglite|postgres|postgresql):\/\//.test(databaseUrl)) fail(500, "CONFIG_INVALID", "Unsupported DATABASE_URL scheme.");
  const cfg: Config = {
    mode, host, port: z.coerce.number().int().min(1).max(65535).parse(env.PORT || 3001), databaseUrl, databaseAuth,
    tenantId: required("AZURE_TENANT_ID"), spaClientId: required("ENTRA_SPA_CLIENT_ID"),
    apiAudience: required("ENTRA_API_AUDIENCE"), apiScope: required("ENTRA_API_SCOPE"),
    gatewayAudience: required("GATEWAY_API_AUDIENCE"), apimPrincipalId: required("APIM_PRINCIPAL_ID"),
    subscriptionId: required("AZURE_SUBSCRIPTION_ID"), foundryResourceGroup: required("FOUNDRY_RESOURCE_GROUP"),
    foundryAccountName: required("FOUNDRY_ACCOUNT_NAME"), foundryEndpoint: required("FOUNDRY_ENDPOINT"),
    apimResourceGroup: required("APIM_RESOURCE_GROUP"), apimServiceName: required("APIM_SERVICE_NAME"),
    apimGatewayUrl: required("APIM_GATEWAY_URL"),
    mcpAllowedHosts: (env.MCP_ALLOWED_HOSTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
    mcpAllowedAudiences: (env.MCP_ALLOWED_AUDIENCES || "").split(",").map(s => s.trim()).filter(Boolean),
    managedIdentityClientId: env.AZURE_CLIENT_ID || undefined,
  };
  if (mode === "azure" && databaseUrl.startsWith("postgres")) {
    const database = new URL(databaseUrl);
    if (database.searchParams.getAll("sslmode").length !== 1 ||
        database.searchParams.get("sslmode") !== "verify-full" || database.searchParams.has("ssl")) {
      fail(500, "CONFIG_INVALID", "Azure PostgreSQL requires exactly one sslmode=verify-full setting, without an ssl override.");
    }
  }
  if (mode === "azure") {
    [cfg.tenantId, cfg.spaClientId, cfg.apiAudience, cfg.gatewayAudience, cfg.apimPrincipalId, cfg.subscriptionId]
      .forEach(v => z.uuid().parse(v));
    if (cfg.managedIdentityClientId) z.uuid().parse(cfg.managedIdentityClientId);
    for (const v of [cfg.foundryResourceGroup, cfg.foundryAccountName, cfg.apimResourceGroup, cfg.apimServiceName]) {
      z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.()-]{0,89}$/).parse(v);
    }
    const endpoint = httpsUrl(cfg.foundryEndpoint, "FOUNDRY_ENDPOINT");
    if (![".openai.azure.com", ".services.ai.azure.com"].some(s => endpoint.hostname.endsWith(s)) ||
      endpoint.pathname !== "/") fail(500, "CONFIG_INVALID", "FOUNDRY_ENDPOINT must be an Azure OpenAI/Foundry account root.");
    if (httpsUrl(cfg.apimGatewayUrl, "APIM_GATEWAY_URL").pathname !== "/") {
      fail(500, "CONFIG_INVALID", "APIM_GATEWAY_URL must be the gateway origin without an API path.");
    }
    if (cfg.apiAudience === cfg.gatewayAudience) fail(500, "CONFIG_INVALID", "User and gateway token audiences must differ.");
  }
  return cfg;
}

export function loadRuntimeConfig(): Config {
  dotenv({ path: resolve(projectRoot, ".env"), quiet: true });
  return loadConfig();
}

export function validateMcpTarget(config: Config, raw: string, audience: string): URL {
  let url: URL;
  try { url = httpsUrl(raw, "MCP backend"); } catch { return fail(400, "MCP_TARGET_REJECTED", "MCP backend must be a public HTTPS URL."); }
  if (!config.mcpAllowedHosts.includes(url.hostname) || !config.mcpAllowedAudiences.includes(audience) ||
      !/^[a-z0-9.-]+$/.test(url.hostname) || url.hostname.endsWith(".local") ||
      /%(?:2f|5c|2e|00)/i.test(url.pathname) || raw.includes("\\") ||
      !/^\/[a-zA-Z0-9/_.~-]*$/.test(url.pathname)) {
    fail(400, "MCP_TARGET_REJECTED", "MCP host, path, and token audience must be explicitly operator-allowlisted.");
  }
  return url;
}
