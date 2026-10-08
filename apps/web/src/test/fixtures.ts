import { vi } from "vitest";
import type { GatewayApi } from "../api";
import type { Model, Session, Team } from "../types";

export const userId = "00000000-0000-4000-8000-000000000001";
export const session: Session = {
  mode: "demo",
  user: { id: userId, name: "Demo administrator", roles: ["Gateway.Admin"] },
};
export const model: Model = {
  id: "model-a", displayName: "Model Alpha", deploymentName: "alpha-deployment",
  modelName: "alpha", modelVersion: "1", status: "ready",
  inputPriceMicrosPerMillion: 150_000, outputPriceMicrosPerMillion: 600_000,
  contextWindowTokens: 128_000, maxOutputTokens: 4_096,
  pricingValidUntil: "2099-01-01T00:00:00.000Z", enabled: true,
};
export const team: Team = {
  id: "engineering", name: "Engineering", monthlyBudgetMicros: 10_000_000,
  spentMicros: 1_000_000, reservedMicros: 2_000_000, period: "2026-09",
  principals: [userId], allowedModels: ["model-a"],
};

export function testApi(overrides: Partial<GatewayApi> = {}): GatewayApi {
  return {
    config: vi.fn(async () => ({ mode: "demo" as const, auth: null })),
    session: vi.fn(async () => session),
    overview: vi.fn(async () => ({
      period: "2026-09", teams: 1, deployments: 1, mcpServers: 0,
      budgetMicros: 10_000_000, spentMicros: 1_000_000, reservedMicros: 2_000_000,
    })),
    teams: vi.fn(async () => [team]),
    models: vi.fn(async () => [model]),
    createTeam: vi.fn(async () => ({})),
    updateTeam: vi.fn(async () => ({})),
    createModel: vi.fn(async () => ({})),
    updateModel: vi.fn(async () => ({})),
    mcpServers: vi.fn(async () => []),
    createMcp: vi.fn(async () => ({})),
    usage: vi.fn(async () => []),
    audit: vi.fn(async () => []),
    chat: vi.fn(async () => ({
      id: "request-1", content: "Simulated response.",
      usage: { promptTokens: 9, completionTokens: 7, chargedMicros: 6 },
    })),
    ...overrides,
  };
}
