import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { isAbsolute, resolve } from "node:path";
import { mkdir, open, rm } from "node:fs/promises";
import { projectRoot } from "./config.js";
import { fail, GatewayError, operationalError } from "./errors.js";
import { postgresPoolConfig, validateDatabaseAuth, type DatabaseConnectionOptions, type DatabaseCredentialFactory } from "./database-auth.js";

export interface Sql {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}
export interface Database extends Sql {
  kind: "embedded" | "postgres";
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
class Mutex {
  private tail = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>(r => { release = r; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}

export async function connectDatabase(
  url: string,
  options: DatabaseConnectionOptions = {},
  credentialFactory?: DatabaseCredentialFactory,
): Promise<Database> {
  validateDatabaseAuth(url, options);
  if (url.startsWith("pglite://")) {
    const data = url.slice("pglite://".length);
    if (!data || data.includes("..") || isAbsolute(data)) throw new Error("Embedded database paths must be relative to the project.");
    const path = data === ":memory:" ? undefined : resolve(projectRoot, data);
    if (path) await mkdir(path, { recursive: true });
    const lockPath = path ? `${path}.gateway.lock` : undefined;
    if (lockPath) {
      // PGlite is single-process. Never allow another server/CLI to open its live data directory.
      const lock = await open(lockPath, "wx");
      try { await lock.writeFile(String(process.pid)); } finally { await lock.close(); }
    }
    const embedded = new PGlite({ dataDir: path, relaxedDurability: false });
    try { await embedded.waitReady; } catch (error) {
      if (lockPath) await rm(lockPath, { force: true });
      throw error;
    }
    const mutex = new Mutex();
    let closed = false;
    return {
      kind: "embedded",
      query: <T>(text: string, params?: unknown[]) => mutex.run(async () => (await embedded.query<T>(text, params)).rows),
      transaction: fn => mutex.run(() => embedded.transaction(tx =>
        fn({ query: async <T>(text: string, params?: unknown[]) => (await tx.query<T>(text, params)).rows }))),
      close: () => mutex.run(async () => {
        if (closed) return;
        await embedded.close();
        if (lockPath) await rm(lockPath, { force: true });
        closed = true;
      }),
    };
  }
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("Unsupported database scheme.");
  const databaseError = (error: unknown): never => {
    if (options.databaseAuth === "entra" && !(error instanceof GatewayError)) {
      fail(503, "DATABASE_OPERATION_FAILED", "PostgreSQL operation failed.");
    }
    throw error;
  };
  const pool = new pg.Pool(postgresPoolConfig(url, options, credentialFactory));
  // Prevent idle-client error events from crashing the process; queries still fail closed.
  pool.on("error", () => { operationalError("database.pool", "IDLE_CONNECTION_FAILED"); });
  try { await pool.query("SELECT 1"); } catch (error) {
    await pool.end().catch(() => { operationalError("database.startup_cleanup", "CLOSE_FAILED"); });
    return databaseError(error);
  }
  return {
    kind: "postgres",
    query: async <T>(text: string, params?: unknown[]) => {
      try { return (await pool.query(text, params)).rows as T[]; } catch (error) { return databaseError(error); }
    },
    transaction: async fn => {
      const client = await pool.connect().catch(databaseError);
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '10s'");
        const result = await fn({ query: async <T>(text: string, params?: unknown[]) => (await client.query(text, params)).rows as T[] });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => { operationalError("database.transaction", "ROLLBACK_FAILED"); });
        return databaseError(error);
      } finally { client.release(); }
    },
    close: () => pool.end().catch(databaseError),
  };
}

export async function verifyRuntimeDatabaseRole(db: Database): Promise<void> {
  const [role] = await db.query<{ safe: boolean }>(`SELECT
    (NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication
      AND NOT r.rolbypassrls AND r.rolcanlogin
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid)
      AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid)) AS safe
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if (role?.safe !== true) {
    fail(500, "DATABASE_RUNTIME_ROLE_UNSAFE", "Entra runtime must use a non-owning, unprivileged PostgreSQL application role.");
  }
}
