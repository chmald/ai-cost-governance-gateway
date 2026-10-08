import { connectDatabase } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { seedDemo, Store } from "../src/store.js";
import { Ledger } from "../src/ledger.js";
import { loadConfig, type Config } from "../src/config.js";
import { DEMO_PRINCIPAL_ID, type ChatInput, type Principal, type ModelInput } from "../src/schemas.js";
import type { Cloud } from "../src/cloud.js";
import { simulated } from "../src/inference.js";

export const principal: Principal = { id: DEMO_PRINCIPAL_ID, name: "Test user", type: "user", roles: ["Gateway.Admin", "Gateway.User", "Gateway.Reader"] };
export const agentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const agentClientId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const agent: Principal = { id: agentId, name: "Test agent", type: "app", clientAppId: agentClientId, roles: ["Gateway.Agent"] };
export const chat: ChatInput = { model: "demo-chat", messages: [{ role: "user", content: "Hello" }], max_completion_tokens: 32 };
export const newModel: ModelInput = {
  id: "new-chat", displayName: "Test deployment", deploymentName: "new-chat", modelName: "gpt-4o-mini", modelVersion: "2024-07-18",
  sku: "GlobalStandard", capacity: 1, inputPriceMicrosPerMillion: 150_000, outputPriceMicrosPerMillion: 600_000,
  contextWindowTokens: 8192, maxOutputTokens: 1024, pricingValidUntil: "2030-01-01T00:00:00.000Z", enabled: true,
};
export function demoConfig(): Config {
  return loadConfig({ GATEWAY_MODE: "demo", DATABASE_URL: "pglite://:memory:" });
}
export function azureConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    GATEWAY_MODE: "azure", DATABASE_URL: "postgresql://test@localhost/test?sslmode=verify-full",
    AZURE_TENANT_ID: "22222222-2222-4222-8222-222222222222",
    ENTRA_SPA_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
    ENTRA_API_AUDIENCE: "44444444-4444-4444-8444-444444444444",
    ENTRA_API_SCOPE: "api://44444444-4444-4444-8444-444444444444/Gateway.Access",
    GATEWAY_API_AUDIENCE: "55555555-5555-4555-8555-555555555555",
    APIM_PRINCIPAL_ID: "66666666-6666-4666-8666-666666666666",
    AZURE_SUBSCRIPTION_ID: "77777777-7777-4777-8777-777777777777",
    FOUNDRY_RESOURCE_GROUP: "test-group", FOUNDRY_ACCOUNT_NAME: "test-account",
    FOUNDRY_ENDPOINT: "https://test-account.openai.azure.com/",
    APIM_RESOURCE_GROUP: "test-group", APIM_SERVICE_NAME: "test-apim",
    APIM_GATEWAY_URL: "https://test-apim.azure-api.net",
    MCP_ALLOWED_HOSTS: "tools.example.com", MCP_ALLOWED_AUDIENCES: "api://trusted-tools",
    ...overrides,
  });
}
export const fakeCloud: Cloud = {
  infer: async input => simulated(input),
  playground: async input => ({ response: simulated(input), chargedMicros: 42 }),
  createDeployment: async () => "Creating",
  deployments: async () => [],
  registerMcp: async () => "Creating",
  pollMcp: async () => "Succeeded",
};

export async function fixture() {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  let date = new Date("2026-09-18T12:00:00.000Z");
  const now = () => date;
  return {
    db, now, store: new Store(db, now), ledger: new Ledger(db, now),
    setDate: (value: string) => { date = new Date(value); },
    reset: async () => {
      date = new Date("2026-09-18T12:00:00.000Z");
      await db.query("TRUNCATE reservations,team_months,teams,models,mcp_servers,audit CASCADE");
      await seedDemo(db);
    },
  };
}
