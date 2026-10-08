import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";
import type { FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { loopbackAddress, loopbackHost } from "./config.js";
import { fail } from "./errors.js";
import { AGENT_ROLE, DEMO_AGENT_CLIENT_ID, DEMO_AGENT_PRINCIPAL_ID, DEMO_PRINCIPAL_ID, principalId, type Principal } from "./schemas.js";

export const DEMO_USER: Principal = Object.freeze({
  id: DEMO_PRINCIPAL_ID, name: "Local demo administrator (FAKE)", type: "user",
  roles: ["Gateway.Admin", "Gateway.Reader", "Gateway.User"],
}) as Principal;
export const DEMO_AGENT: Principal = Object.freeze({
  id: DEMO_AGENT_PRINCIPAL_ID, name: "Local demo agent identity (FAKE, app-only)", type: "app",
  clientAppId: DEMO_AGENT_CLIENT_ID, roles: [AGENT_ROLE],
}) as Principal;

const claimRoles = (payload: JWTPayload): string[] =>
  Array.isArray(payload.roles) ? payload.roles.filter((v): v is string => typeof v === "string") : [];

export function bearer(header: unknown): string {
  if (typeof header !== "string" || !/^Bearer [A-Za-z0-9._~-]+$/i.test(header)) {
    return fail(401, "UNAUTHENTICATED", "A valid bearer access token is required.");
  }
  return header.slice(7);
}

export function role(principal: Principal, roles: string[]): void {
  if (!roles.some(r => principal.roles.includes(r))) fail(403, "FORBIDDEN", "Required gateway role is missing.");
}

export class Auth {
  private keys?: JWTVerifyGetKey;
  constructor(private config: Config, keys?: JWTVerifyGetKey) {
    if (config.mode === "azure") this.keys = keys ?? createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`),
      { timeoutDuration: 5000, cooldownDuration: 30_000 });
  }

  checkLocal(request: FastifyRequest): void {
    if (this.config.mode !== "demo") return;
    let host: string;
    try { host = new URL(`http://${request.headers.host}`).hostname; } catch { return fail(403, "DEMO_LOCAL_ONLY", "Invalid local request host."); }
    if (!loopbackHost(host) || !loopbackAddress(request.ip) ||
        request.headers["x-forwarded-host"] || request.headers["x-forwarded-for"]) {
      fail(403, "DEMO_LOCAL_ONLY", "Demo accepts direct loopback requests only.");
    }
  }

  private async verify(token: string, audience: string, gateway = false): Promise<JWTPayload> {
    try {
      const issuers = [`https://login.microsoftonline.com/${this.config.tenantId}/v2.0`];
      if (gateway) issuers.push(`https://sts.windows.net/${this.config.tenantId}/`);
      const { payload } = await jwtVerify(token, this.keys!, {
        issuer: issuers, audience, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "oid", "tid"],
        clockTolerance: 5,
      });
      if (payload.tid !== this.config.tenantId || !principalId.safeParse(payload.oid).success) throw new Error("Invalid principal");
      return payload;
    } catch { return fail(401, "INVALID_TOKEN", "Access token validation failed."); }
  }

  async user(request: FastifyRequest): Promise<Principal> {
    return this.caller(request);
  }

  /**
   * Resolves the calling principal. Delegated user tokens (scp) are always accepted when valid.
   * App-only tokens (managed identities, service principals, agent identities) are accepted only
   * when allowApp is set and the token carries the application-permission app role Gateway.Agent.
   */
  async caller(request: FastifyRequest, { allowApp = false }: { allowApp?: boolean } = {}): Promise<Principal> {
    if (this.config.mode === "demo") {
      this.checkLocal(request);
      return allowApp && request.headers["x-demo-caller"] === "app" ? DEMO_AGENT : DEMO_USER;
    }
    const payload = await this.verify(bearer(request.headers.authorization), this.config.apiAudience);
    const scope = this.config.apiScope.slice(this.config.apiScope.lastIndexOf("/") + 1);
    const roles = claimRoles(payload);
    if (typeof payload.scp === "string") {
      if (payload.idtyp === "app" || !payload.scp.split(" ").includes(scope)) {
        fail(401, "USER_TOKEN_REQUIRED", "A delegated user access token with the gateway scope is required.");
      }
      // Gateway.Agent is an application permission; never honor it on a delegated user token.
      return { id: payload.oid as string, name: typeof payload.name === "string" ? payload.name.slice(0, 120) : "Entra user",
        roles: roles.filter(r => r !== AGENT_ROLE), type: "user" };
    }
    if (payload.scp !== undefined || !allowApp) {
      fail(401, "USER_TOKEN_REQUIRED", "A delegated user access token with the gateway scope is required.");
    }
    const clientAppId = typeof payload.azp === "string" ? payload.azp : payload.appid;
    if ((payload.idtyp !== undefined && payload.idtyp !== "app") || !principalId.safeParse(clientAppId).success ||
        payload.oid === this.config.apimPrincipalId) {
      fail(401, "INVALID_TOKEN", "Access token validation failed.");
    }
    if (!roles.includes(AGENT_ROLE)) {
      fail(403, "APP_ROLE_REQUIRED", "App-only callers require the Gateway.Agent application role.");
    }
    return { id: payload.oid as string, name: `Application ${clientAppId as string}`, roles: [AGENT_ROLE],
      type: "app", clientAppId: clientAppId as string };
  }

  async gateway(request: FastifyRequest): Promise<void> {
    if (this.config.mode === "demo") { this.checkLocal(request); return; }
    const p = await this.verify(bearer(request.headers["x-gateway-authorization"]), this.config.gatewayAudience, true);
    if (p.oid !== this.config.apimPrincipalId || p.scp !== undefined ||
        (p.idtyp !== undefined && p.idtyp !== "app") ||
        (typeof p.appid !== "string" && typeof p.azp !== "string") ||
        !Array.isArray(p.roles) || !p.roles.includes("Gateway.Invoke")) {
      fail(403, "GATEWAY_PROOF_REQUIRED", "The configured API Management application identity is required.");
    }
  }
}
