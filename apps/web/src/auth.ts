import { ApiError } from "./api";
import type { PublicConfig } from "./types";

export interface AuthClient {
  signIn: () => Promise<void>;
  getToken: () => Promise<string>;
  signOut: () => Promise<void>;
}

export async function createAuth(config: PublicConfig): Promise<AuthClient> {
  const auth = config.auth;
  const guid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (!auth || !guid.test(auth.tenantId) || !guid.test(auth.clientId) || !auth.apiScope?.trim()) {
    throw new Error("Azure sign-in is not configured. The gateway must publish a single tenant ID, SPA client ID, and API scope.");
  }
  const { PublicClientApplication, InteractionRequiredAuthError, BrowserCacheLocation } =
    await import("@azure/msal-browser");
  const client = new PublicClientApplication({
    auth: {
      clientId: auth.clientId,
      authority: `https://login.microsoftonline.com/${auth.tenantId}`,
      redirectUri: `${window.location.origin}/auth.html`,
      postLogoutRedirectUri: window.location.origin,
    },
    cache: { cacheLocation: BrowserCacheLocation.MemoryStorage },
  });
  await client.initialize();
  const scopes = [auth.apiScope];
  return {
    async signIn() {
      const account = client.getActiveAccount();
      const response = account
        ? await client.acquireTokenPopup({ scopes, account })
        : await client.loginPopup({ scopes, prompt: "select_account" });
      client.setActiveAccount(response.account);
    },
    async getToken() {
      const account = client.getActiveAccount();
      if (!account) throw new ApiError(401, "SIGN_IN_REQUIRED", "Use Sign in to connect your work account.");
      try {
        const response = await client.acquireTokenSilent({ scopes, account });
        return response.accessToken;
      } catch (error) {
        if (error instanceof InteractionRequiredAuthError) {
          throw new ApiError(401, "INTERACTION_REQUIRED", "Use Reconnect to renew your Microsoft Entra session. No request was replayed.");
        }
        throw new ApiError(401, "TOKEN_UNAVAILABLE", "A gateway access token could not be acquired. Use Reconnect to sign in again.");
      }
    },
    async signOut() {
      const account = client.getActiveAccount();
      await client.logoutPopup({ account, mainWindowRedirectUri: window.location.origin });
      client.setActiveAccount(null);
    },
  };
}
