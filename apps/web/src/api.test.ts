import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi, errorMessage } from "./api";

function mockResponse(body: unknown, status = 200) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("HTTP contract", () => {
  it("unwraps items lists and sends acquired tokens in the header only", async () => {
    const fetcher = mockResponse({ items: [] });
    const api = createApi(async () => "test-access-token");
    await expect(api.teams()).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledWith("/api/teams", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer test-access-token" }),
      cache: "no-store", credentials: "same-origin",
    }));
    expect(localStorage.length).toBe(0);
  });
  it("surfaces structured backend errors without retrying", async () => {
    const fetcher = mockResponse({ error: { code: "BUDGET_EXCEEDED", message: "Not enough available budget." } }, 409);
    await expect(createApi().chat({ teamId: "a", modelId: "b", messages: [], maxCompletionTokens: 3 }))
      .rejects.toMatchObject({ status: 409, code: "BUDGET_EXCEEDED", message: "Not enough available budget." });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("makes disconnected mutation uncertainty explicit and never retries", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetcher);
    await expect(createApi().chat({ teamId: "a", modelId: "b", messages: [], maxCompletionTokens: 3 }))
      .rejects.toMatchObject({ code: "DISCONNECTED", message: expect.stringContaining("outcome is unknown") });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("requires a valid mode instead of defaulting to demo", async () => {
    mockResponse({ auth: null });
    await expect(createApi().config()).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
  it("rejects malformed lists instead of pretending they are empty", async () => {
    mockResponse([]);
    await expect(createApi().models()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("does not send a request if token acquisition fails", async () => {
    const fetcher = mockResponse({ items: [] });
    const api = createApi(async () => { throw new ApiError(401, "INTERACTION_REQUIRED", "Reconnect."); });
    await expect(api.teams()).rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("handles non-JSON error responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", { status: 502 })));
    await expect(createApi().overview()).rejects.toMatchObject({ status: 502, code: "INVALID_RESPONSE" });
  });
  it("rejects incomplete inference results without creating an artificial charge", async () => {
    const fetcher = mockResponse({ id: "request-1", content: "Output without usage." });
    await expect(createApi().chat({ teamId: "a", modelId: "b", messages: [], maxCompletionTokens: 3 }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE", message: expect.stringContaining("may have completed") });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("clearly distinguishes unauthorized and forbidden responses", () => {
    expect(errorMessage(new ApiError(401, "AUTH", "Expired."))).toContain("Sign-in required.");
    expect(errorMessage(new ApiError(403, "FORBIDDEN", "Not a member."))).toContain("Access denied.");
  });
});
