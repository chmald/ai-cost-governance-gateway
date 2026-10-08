import { ManagedIdentityCredential } from "@azure/identity";
import type { PoolConfig } from "pg";
import { fail } from "./errors.js";

export type DatabaseAuth = "password" | "entra";
export interface DatabaseConnectionOptions {
  databaseAuth?: DatabaseAuth;
  mode?: "demo" | "azure";
  managedIdentityClientId?: string;
}
export interface DatabaseCredential {
  getToken(scope: string): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}
export type DatabaseCredentialFactory = (clientId: string) => DatabaseCredential;
export const postgresScope = "https://ossrdbms-aad.database.windows.net/.default";
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const postgresHostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.postgres\.database\.azure\.com$/;
export const postgresNamePattern = /^[a-z_][a-z0-9_]{0,62}$/;
export const postgresLoginPattern = /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/;

function invalid(message: string): never {
  return fail(500, "DATABASE_CONFIG_INVALID", message);
}

export function validateDatabaseAuth(url: string, options: DatabaseConnectionOptions = {}): URL | undefined {
  const auth = options.databaseAuth ?? "password";
  if (auth !== "password" && auth !== "entra") invalid("DATABASE_AUTH must be password or entra.");
  if (auth === "password") return;
  if (options.mode !== "azure") invalid("Entra database authentication requires explicit GATEWAY_MODE=azure.");
  if (!options.managedIdentityClientId || !uuidPattern.test(options.managedIdentityClientId)) {
    invalid("Entra database authentication requires a valid AZURE_CLIENT_ID.");
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { return invalid("Entra authentication requires a valid PostgreSQL URL."); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !postgresHostPattern.test(parsed.hostname) || (parsed.port && parsed.port !== "5432") ||
      !postgresLoginPattern.test(parsed.username) || !postgresNamePattern.test(parsed.pathname.slice(1)) ||
      parsed.password || parsed.hash || url.includes("\\") ||
      parsed.searchParams.getAll("sslmode").length !== 1 ||
      parsed.searchParams.get("sslmode") !== "verify-full" ||
      [...parsed.searchParams.keys()].some(key => key !== "sslmode")) {
    invalid("Entra DATABASE_URL must be passwordless Azure PostgreSQL on port 5432 with only sslmode=verify-full.");
  }
  return parsed;
}

export function postgresPoolConfig(
  url: string,
  options: DatabaseConnectionOptions = {},
  credentialFactory: DatabaseCredentialFactory = clientId => new ManagedIdentityCredential({ clientId }),
): PoolConfig {
  const parsed = validateDatabaseAuth(url, options);
  const limits = { max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000 };
  if (!parsed) return { ...limits, connectionString: url };
  let credential: DatabaseCredential;
  try { credential = credentialFactory(options.managedIdentityClientId!); }
  catch { return fail(503, "DATABASE_IDENTITY_FAILED", "PostgreSQL managed identity authentication failed."); }
  return {
    ...limits,
    // A connectionString can overwrite pg's password callback. Pass validated fields instead.
    host: parsed.hostname, port: 5432, user: parsed.username, database: parsed.pathname.slice(1),
    ssl: { rejectUnauthorized: true },
    password: async () => {
      try {
        const access = await credential.getToken(postgresScope);
        if (!access?.token || !Number.isFinite(access.expiresOnTimestamp) || access.expiresOnTimestamp <= Date.now()) {
          throw new Error("Unavailable token.");
        }
        return access.token;
      } catch {
        // SDK diagnostics can contain sensitive endpoint responses; do not retain a cause.
        return fail(503, "DATABASE_IDENTITY_FAILED", "PostgreSQL managed identity authentication failed.");
      }
    },
  };
}
