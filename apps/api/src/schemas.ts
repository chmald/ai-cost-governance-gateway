import { z } from "zod";

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const principalId = z.uuid();
export const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const price = money.positive();
const name = z.string().trim().min(1).max(120);
export const teamFields = z.object({
  name,
  monthlyBudgetMicros: money,
  allowedModels: z.array(identifier).max(200).refine(v => new Set(v).size === v.length),
  principals: z.array(principalId).max(500).refine(v => new Set(v).size === v.length),
  // Service-principal object IDs (token oid) of managed identities, service principals or agent identities.
  // Optional for compatibility: omitting it on update preserves the stored list.
  applications: z.array(principalId).max(200).refine(v => new Set(v).size === v.length).optional(),
}).strict();
export const teamCreate = teamFields.extend({ id: identifier });
export const modelFields = z.object({
  displayName: name,
  inputPriceMicrosPerMillion: price,
  outputPriceMicrosPerMillion: price,
  contextWindowTokens: z.number().int().min(128).max(2_000_000),
  maxOutputTokens: z.number().int().min(1).max(200_000),
  pricingValidUntil: z.iso.datetime({ offset: true }),
  enabled: z.boolean(),
}).strict();
export const modelCreate = modelFields.extend({
  id: identifier,
  deploymentName: identifier,
  modelName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  modelVersion: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
  sku: z.enum(["Standard", "GlobalStandard", "DataZoneStandard"]),
  capacity: z.number().int().min(1).max(10_000),
});
export const mcpCreate = z.object({
  id: identifier,
  name,
  path: z.string().regex(/^mcp\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
    .refine(path => path.toLowerCase() !== "mcp/governance", "The built-in governance path is reserved."),
  backendUrl: z.string().url().max(2048),
  authAudience: z.string().min(1).max(256),
}).strict();
export const messages = z.array(z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(128_000),
}).strict()).min(1).max(64);
export const completion = z.object({
  model: identifier,
  messages,
  max_completion_tokens: z.number().int().min(1).max(200_000),
  stream: z.literal(false).optional(),
  n: z.literal(1).optional(),
}).strict();
export const playground = z.object({
  teamId: identifier,
  modelId: identifier,
  messages,
  maxCompletionTokens: z.number().int().min(1).max(200_000),
  simulateAgent: z.boolean().optional(),
}).strict();

export type TeamInput = z.infer<typeof teamCreate>;
export type ModelInput = z.infer<typeof modelCreate>;
export type ModelUpdate = z.infer<typeof modelFields>;
export type McpInput = z.infer<typeof mcpCreate>;
export type ChatInput = z.infer<typeof completion>;
export type Model = Omit<ModelInput, "sku"> & { sku: string; format?: string; status: string; quarantined?: boolean };
export type DeploymentInventory = {
  name: string; modelName: string; modelVersion: string; status: string; sku: string; capacity: number; format: string;
};
export const supportedDeployment = (model: Pick<Model, "sku" | "format">): boolean =>
  ["Standard", "GlobalStandard", "DataZoneStandard"].includes(model.sku) &&
  (model.format === undefined || model.format === "OpenAI");
export type Team = TeamInput;
export type McpServer = McpInput & { status: string; toolCostsCovered: false };
export type PrincipalType = "user" | "app";
export type Principal = { id: string; name: string; roles: string[]; type: PrincipalType; clientAppId?: string };
export type Caller = Pick<Principal, "id" | "type" | "clientAppId">;
export const AGENT_ROLE = "Gateway.Agent";
export const DEMO_PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
// Clearly fake, local-only application identity used to demonstrate app-only (agent) callers offline.
export const DEMO_AGENT_PRINCIPAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const DEMO_AGENT_CLIENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export function inputBound(input: ChatInput): number {
  // UTF-8 bytes upper-bound text tokens; generous per-message framing avoids tokenizer guesses.
  return input.messages.reduce((n, message) => n + Buffer.byteLength(message.content, "utf8") + 128, 256);
}
