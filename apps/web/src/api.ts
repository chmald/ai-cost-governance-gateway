import type {
  Audit, ChatInput, ChatResponse, McpInput, McpServer, Model, ModelGovernance,
  ModelInput, Overview, PublicConfig, Session, Team, TeamInput, Usage,
} from "./types";

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const prefix = error.status === 401 ? "Sign-in required. "
      : error.status === 403 ? "Access denied. " : "";
    return `${prefix}${error.message} (${error.code})`;
  }
  return error instanceof Error ? error.message : "An unexpected error occurred. No action was confirmed.";
}

export function createApi(getToken?: () => Promise<string>) {
  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const token = getToken ? await getToken() : undefined;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetch(path, {
        method, headers, cache: "no-store", credentials: "same-origin",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError(0, "DISCONNECTED", method === "GET"
        ? "Cannot reach the gateway. Check your connection and that the API is running."
        : "Connection lost. The action's outcome is unknown. Check the ledger or status before submitting again; inference is never automatically retried.");
    }
    let payload: unknown;
    try {
      payload = response.status === 204 ? undefined : await response.json();
    } catch {
      throw new ApiError(response.status, "INVALID_RESPONSE", response.ok
        ? "The gateway returned an unreadable response. The action may have completed; check its status before repeating it."
        : `The gateway returned HTTP ${response.status} without a valid error response.`);
    }
    if (!response.ok) {
      const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      throw new ApiError(response.status,
        typeof error?.code === "string" ? error.code : `HTTP_${response.status}`,
        typeof error?.message === "string" ? error.message : `The request failed (HTTP ${response.status}).`);
    }
    return payload as T;
  }

  async function list<T>(path: string): Promise<T[]> {
    const payload = await request<{ items: T[] }>(path);
    if (!payload || !Array.isArray(payload.items)) {
      throw new ApiError(200, "INVALID_RESPONSE", "The gateway did not return the expected items list.");
    }
    return payload.items;
  }

  return {
    config: async (): Promise<PublicConfig> => {
      const value = await request<PublicConfig>("/api/config");
      if (!value || !["azure", "demo"].includes(value.mode)) {
        throw new ApiError(200, "INVALID_CONFIG", "Gateway mode is missing or invalid. Demo mode will not be assumed.");
      }
      return value;
    },
    session: () => request<Session>("/api/session"),
    overview: () => request<Overview>("/api/overview"),
    teams: () => list<Team>("/api/teams"),
    createTeam: (input: TeamInput) => request<unknown>("/api/teams", "POST", input),
    updateTeam: (id: string, input: Omit<TeamInput, "id">) =>
      request<unknown>(`/api/teams/${encodeURIComponent(id)}`, "PUT", input),
    models: () => list<Model>("/api/models"),
    createModel: (input: ModelInput) => request<unknown>("/api/models", "POST", input),
    updateModel: (id: string, input: ModelGovernance) =>
      request<unknown>(`/api/models/${encodeURIComponent(id)}`, "PUT", input),
    mcpServers: () => list<McpServer>("/api/mcp-servers"),
    createMcp: (input: McpInput) => request<unknown>("/api/mcp-servers", "POST", input),
    usage: () => list<Usage>("/api/usage"),
    audit: () => list<Audit>("/api/audit"),
    chat: async (input: ChatInput): Promise<ChatResponse> => {
      const result = await request<ChatResponse>("/api/playground/chat", "POST", input);
      if (!result || typeof result.id !== "string" || typeof result.content !== "string" ||
          !result.usage || ![result.usage.promptTokens, result.usage.completionTokens, result.usage.chargedMicros]
            .every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new ApiError(200, "INVALID_RESPONSE", "The chat response was incomplete. The request may have completed; check usage before sending another request.");
      }
      return result;
    },
  };
}

export type GatewayApi = ReturnType<typeof createApi>;
