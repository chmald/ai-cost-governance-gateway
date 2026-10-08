export interface PublicConfig {
  mode: "demo" | "azure";
  auth?: { tenantId: string; clientId: string; apiScope: string } | null;
}

export interface Session {
  user: { id: string; name: string; roles: string[]; type?: "user" | "app" };
  mode: PublicConfig["mode"];
  /** Local demo only: the fake app-only identity used to simulate an agent caller offline. */
  demoAgent?: { id: string; name: string; clientAppId: string };
}

export interface Overview {
  period: string;
  teams: number;
  deployments: number;
  mcpServers: number;
  budgetMicros: number;
  spentMicros: number;
  reservedMicros: number;
}

export interface TeamInput {
  id: string;
  name: string;
  monthlyBudgetMicros: number;
  allowedModels: string[];
  principals: string[];
  /** Service-principal object IDs of app-only callers (managed identities, service principals, agents). */
  applications?: string[];
}

export interface Team extends TeamInput {
  spentMicros: number;
  reservedMicros: number;
  period: string;
}

export interface ModelGovernance {
  displayName: string;
  inputPriceMicrosPerMillion: number;
  outputPriceMicrosPerMillion: number;
  contextWindowTokens: number;
  maxOutputTokens: number;
  pricingValidUntil: string;
  enabled: boolean;
}

export interface Model extends ModelGovernance {
  id: string;
  deploymentName: string;
  modelName: string;
  modelVersion: string;
  status: string;
}

export interface ModelInput extends ModelGovernance {
  id: string;
  deploymentName: string;
  modelName: string;
  modelVersion: string;
  sku: string;
  capacity: number;
}

export interface McpInput {
  id: string;
  name: string;
  path: string;
  backendUrl: string;
  authAudience: string;
}

export interface McpServer extends McpInput {
  status: string;
  toolCostsCovered: false;
}

export interface Usage {
  id: string;
  createdAt: string;
  teamId: string;
  modelId: string;
  reservedMicros: number;
  chargedMicros: number;
  status: string;
  promptTokens?: number;
  completionTokens?: number;
  actorId?: string;
  actorType?: "user" | "app";
  clientAppId?: string;
}

export interface Audit {
  id: string;
  timestamp: string;
  actor: string;
  actorType?: "user" | "app" | "system" | "unknown";
  action: string;
  target: string;
  outcome: string;
  detail: string;
}

export interface ChatInput {
  teamId: string;
  modelId: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  maxCompletionTokens: number;
  simulateAgent?: boolean;
}

export interface ChatResponse {
  id: string;
  content: string;
  usage: { promptTokens: number; completionTokens: number; chargedMicros: number };
}
