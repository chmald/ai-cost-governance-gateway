import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./auth";
import type { PublicConfig } from "./types";

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(), loginPopup: vi.fn(), acquireTokenPopup: vi.fn(),
  acquireTokenSilent: vi.fn(), logoutPopup: vi.fn(), getActiveAccount: vi.fn(),
  setActiveAccount: vi.fn(), configuration: vi.fn(),
}));

vi.mock("@azure/msal-browser", () => ({
  PublicClientApplication: class {
    constructor(config: unknown) { mocks.configuration(config); }
    initialize = mocks.initialize;
    loginPopup = mocks.loginPopup;
    acquireTokenPopup = mocks.acquireTokenPopup;
    acquireTokenSilent = mocks.acquireTokenSilent;
    logoutPopup = mocks.logoutPopup;
    getActiveAccount = mocks.getActiveAccount;
    setActiveAccount = mocks.setActiveAccount;
  },
  BrowserCacheLocation: { MemoryStorage: "memoryStorage" },
  InteractionRequiredAuthError: class extends Error {},
}));

const config: PublicConfig = {
  mode: "azure",
  auth: {
    tenantId: "00000000-0000-4000-8000-000000000001",
    clientId: "00000000-0000-4000-8000-000000000002",
    apiScope: "api://gateway/access_as_user",
  },
};

describe("single-tenant MSAL integration", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.initialize.mockResolvedValue(undefined);
  });
  it("initializes only, uses in-memory tokens, and never triggers automatic login", async () => {
    await createAuth(config);
    expect(mocks.initialize).toHaveBeenCalledOnce();
    expect(mocks.configuration).toHaveBeenCalledWith(expect.objectContaining({
      auth: expect.objectContaining({
        authority: "https://login.microsoftonline.com/00000000-0000-4000-8000-000000000001",
        redirectUri: `${window.location.origin}/auth.html`,
      }),
      cache: { cacheLocation: "memoryStorage" },
    }));
    expect(mocks.loginPopup).not.toHaveBeenCalled();
    expect(mocks.acquireTokenPopup).not.toHaveBeenCalled();
  });
  it("uses acquireTokenSilent and does not open an interaction on failure", async () => {
    const { InteractionRequiredAuthError } = await import("@azure/msal-browser");
    mocks.getActiveAccount.mockReturnValue({ homeAccountId: "account" });
    mocks.acquireTokenSilent.mockRejectedValue(new InteractionRequiredAuthError("interaction_required"));
    const auth = await createAuth(config);
    await expect(auth.getToken()).rejects.toMatchObject({ status: 401, code: "INTERACTION_REQUIRED" });
    expect(mocks.acquireTokenPopup).not.toHaveBeenCalled();
    expect(mocks.loginPopup).not.toHaveBeenCalled();
  });
  it("returns a silent access token and supports explicit sign-out", async () => {
    const account = { homeAccountId: "account" };
    mocks.getActiveAccount.mockReturnValue(account);
    mocks.acquireTokenSilent.mockResolvedValue({ accessToken: "test-token" });
    mocks.logoutPopup.mockResolvedValue(undefined);
    const auth = await createAuth(config);
    await expect(auth.getToken()).resolves.toBe("test-token");
    expect(mocks.acquireTokenSilent).toHaveBeenCalledWith({ account, scopes: ["api://gateway/access_as_user"] });
    await auth.signOut();
    expect(mocks.logoutPopup).toHaveBeenCalledOnce();
    expect(mocks.setActiveAccount).toHaveBeenCalledWith(null);
  });
  it("rejects common/multitenant or incomplete configuration", async () => {
    await expect(createAuth({ mode: "azure", auth: { ...config.auth!, tenantId: "common" } })).rejects.toThrow("single tenant ID");
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
});
