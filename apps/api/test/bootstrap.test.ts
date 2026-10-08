import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapDatabase, ensureRuntimeRole, initializeApplicationDatabase, loadBootstrapConfig, type BootstrapConfig } from "../src/bootstrap.js";
import { connectDatabase, type Database, type Sql } from "../src/db.js";
import { fixture, chat, principal } from "./helpers.js";

const runtimeId = "11111111-1111-4111-8111-111111111111";
const migrationId = "22222222-2222-4222-8222-222222222222";
const tenantId = "33333333-3333-4333-8333-333333333333";
const env: NodeJS.ProcessEnv = {
  GATEWAY_MODE: "azure", DATABASE_AUTH: "entra", AZURE_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
  POSTGRES_HOST: "gateway-server.postgres.database.azure.com", POSTGRES_DATABASE: "gateway",
  POSTGRES_APP_ROLE: "gateway_app", MIGRATION_PRINCIPAL_NAME: "gateway-migration", RUNTIME_PRINCIPAL_ID: runtimeId,
};
const config = loadBootstrapConfig(env);
const normalRole = { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true };
const runtimeMapping = { rolename: config.appRole, principal_type: "service", object_id: runtimeId, tenant_id: tenantId, is_mfa: 0, is_admin: 0 };
const adminMapping = { ...runtimeMapping, rolename: config.migrationPrincipalName, object_id: migrationId, is_admin: 1 };

// Only a unit mock of Azure's extension, never evidence of a live Azure integration.
function mockAdmin(existing = true) {
  const state = {
    mappings: existing ? [{ ...adminMapping }, { ...runtimeMapping }] : [{ ...adminMapping }],
    role: existing ? { ...normalRole } : undefined as typeof normalRole | undefined,
    memberships: [] as unknown[], created: 0, calls: [] as string[], closed: 0, commits: 0, rollbacks: 0,
  };
  const db: Database = {
    kind: "postgres",
    async query<T>(sql: string, params?: unknown[]) {
      state.calls.push(sql);
      let result: unknown[] = [];
      if (sql.includes("session_user")) result = [{ login: config.migrationPrincipalName, database: "postgres" }];
      else if (sql.includes("pgaadauth_list_principals")) {
        assert.ok(sql.includes("(false)"));
        result = state.mappings;
      } else if (sql.includes("pgaadauth_create_principal_with_oid")) {
        assert.deepEqual(params, [config.appRole, runtimeId]);
        assert.ok(sql.includes("'service', false, false"));
        state.created++;
        state.mappings.push({ ...runtimeMapping });
        state.role = { ...normalRole };
      } else if (sql.includes("pg_auth_members")) result = state.memberships;
      else if (sql.includes("pg_catalog.pg_roles")) result = state.role ? [state.role] : [];
      else assert.ok(sql.includes("pg_advisory_xact_lock"), sql);
      return result as T[];
    },
    async transaction(fn) {
      const old = { mappings: structuredClone(state.mappings), role: state.role, created: state.created };
      try { const result = await fn(db); state.commits++; return result; }
      catch (error) { Object.assign(state, old); state.rollbacks++; throw error; }
    },
    async close() { state.closed++; },
  };
  return { db, state };
}

function mockApplication() {
  const calls: string[] = [];
  let commits = 0;
  let closed = 0;
  const db: Database = {
    kind: "postgres",
    async query<T>(sql: string, params?: unknown[]) {
      calls.push(sql);
      let result: unknown[] = [];
      if (sql.includes("session_user")) result = [{ login: config.migrationPrincipalName, database: config.database }];
      else if (sql === "SELECT version FROM gateway_migrations") result = [{ version: 1 }, { version: 2 }];
      else if (sql.includes("AS owns_objects")) result = [{ owns_objects: false }];
      else if (sql.includes("pg_auth_members")) result = [];
      else if (sql.includes("pg_catalog.pg_roles")) result = [{ ...normalRole }];
      else if (sql.includes("has_table_privilege")) {
        const allowed = params?.[1] === "public.gateway_migrations" ? ["SELECT"]
          : params?.[1] === "public.audit" ? ["SELECT", "INSERT"] : ["SELECT", "INSERT", "UPDATE"];
        result = [{ permitted: allowed.includes(String(params?.[2])), grantable: false }];
      }
      return result as T[];
    },
    async transaction(fn) { const result = await fn(db); commits++; return result; },
    async close() { closed++; },
  };
  return { db, calls, commits: () => commits, closed: () => closed };
}

test("bootstrap configuration requires explicit cloud/auth, safe names, separated logins and identity UUIDs", async () => {
  assert.deepEqual(config, {
    host: env.POSTGRES_HOST, database: env.POSTGRES_DATABASE, appRole: env.POSTGRES_APP_ROLE,
    migrationPrincipalName: env.MIGRATION_PRINCIPAL_NAME, runtimePrincipalId: runtimeId, managedIdentityClientId: env.AZURE_CLIENT_ID,
  });
  const invalid = [
    { GATEWAY_MODE: undefined }, { GATEWAY_MODE: "demo" }, { DATABASE_AUTH: undefined }, { DATABASE_AUTH: "password" },
    { DATABASE_URL: "pglite://data/gateway" }, { DATABASE_URL: "postgresql://sensitive-credential@localhost/db" },
    { POSTGRES_HOST: "localhost" }, { POSTGRES_HOST: "gateway-server.postgres.database.azure.com.evil.test" },
    { POSTGRES_HOST: "https://gateway-server.postgres.database.azure.com" }, { POSTGRES_HOST: "gateway-server.postgres.database.azure.com:5432" },
    { POSTGRES_DATABASE: "" }, { POSTGRES_DATABASE: "postgres" }, { POSTGRES_DATABASE: "template1" },
    { POSTGRES_DATABASE: "x; DROP ROLE x" }, { POSTGRES_DATABASE: "a".repeat(64) },
    { POSTGRES_APP_ROLE: "" }, { POSTGRES_APP_ROLE: "pg_read_all_data" }, { POSTGRES_APP_ROLE: "azure_pg_admin" },
    { POSTGRES_APP_ROLE: "gateway\"admin" }, { POSTGRES_APP_ROLE: "public" },
    { MIGRATION_PRINCIPAL_NAME: "gateway_app" }, { MIGRATION_PRINCIPAL_NAME: "user@badhost" },
    { MIGRATION_PRINCIPAL_NAME: "" }, { RUNTIME_PRINCIPAL_ID: "" }, { RUNTIME_PRINCIPAL_ID: "sensitive-credential" },
    { AZURE_CLIENT_ID: undefined }, { AZURE_CLIENT_ID: "sensitive-credential" },
  ];
  for (const override of invalid) {
    let connected = false;
    await assert.rejects(bootstrapDatabase({ ...env, ...override }, async () => {
      connected = true;
      throw new Error("Network must not be attempted.");
    }), error => error instanceof Error && !error.message.includes("sensitive-credential"));
    assert.equal(connected, false);
  }
});

test("runtime principal creation uses the documented nonadmin service mapping and verifies it", async () => {
  const { db, state } = mockAdmin(false);
  await ensureRuntimeRole(db, config);
  assert.equal(state.created, 1);
  assert.equal(state.calls.filter(sql => sql.includes("pgaadauth_list_principals")).length, 2);
  assert.deepEqual(state.mappings[1], runtimeMapping);
  await ensureRuntimeRole(db, config);
  assert.equal(state.created, 1);
});

test("already-correct role mappings are read-only and case-insensitive for UUIDs", async () => {
  const { db, state } = mockAdmin();
  state.mappings[1]!.object_id = runtimeId.toUpperCase();
  await ensureRuntimeRole(db, config);
  assert.equal(state.created, 0);
  assert.ok(state.calls.every(sql => sql.startsWith("SELECT")));
});

test("wrong object, tenant, principal type, MFA, and admin mappings are refused without remapping", async () => {
  for (const change of [
    { object_id: migrationId }, { tenant_id: runtimeId }, { principal_type: "group" }, { is_mfa: 1 }, { is_admin: 1 },
  ]) {
    const { db, state } = mockAdmin();
    Object.assign(state.mappings[1]!, change);
    await assert.rejects(ensureRuntimeRole(db, config));
    assert.equal(state.created, 0);
    assert.ok(state.calls.every(sql => !/ALTER|SECURITY LABEL|DROP|create_principal/.test(sql)));
  }
});

test("runtime cannot also be the migration administrator or log in through another mapped role", async () => {
  for (const alias of [{ ...adminMapping, object_id: runtimeId }, { ...runtimeMapping, rolename: "other_app" }]) {
    const { db, state } = mockAdmin();
    state.mappings.push(alias);
    await assert.rejects(ensureRuntimeRole(db, config));
    assert.equal(state.created, 0);
  }
});

test("unmapped existing roles, PostgreSQL elevation, memberships, and unprovisioned administrator fail closed", async () => {
  for (const attribute of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"] as const) {
    const { db, state } = mockAdmin();
    state.role![attribute] = true;
    await assert.rejects(ensureRuntimeRole(db, config));
    assert.equal(state.created, 0);
  }
  for (const mutate of [
    (state: ReturnType<typeof mockAdmin>["state"]) => { state.memberships = [{ role: "migration-administrator" }]; },
    (state: ReturnType<typeof mockAdmin>["state"]) => { state.role!.rolcanlogin = false; },
    (state: ReturnType<typeof mockAdmin>["state"]) => { state.mappings.pop(); },
    (state: ReturnType<typeof mockAdmin>["state"]) => { state.mappings.shift(); },
    (state: ReturnType<typeof mockAdmin>["state"]) => { state.mappings[0]!.is_admin = 0; },
  ]) {
    const { db, state } = mockAdmin();
    mutate(state);
    await assert.rejects(ensureRuntimeRole(db, config));
    assert.equal(state.created, 0);
  }
});

test("an unavailable/no-op Azure extension is not considered a successful mapping", async () => {
  const { db, state } = mockAdmin(false);
  const query = db.query.bind(db);
  for (const noOp of [false, true]) {
    db.query = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes("pgaadauth_create")) {
        if (noOp) return [];
        throw new Error("Extension unavailable.");
      }
      return query<T>(sql, params);
    };
    await assert.rejects(ensureRuntimeRole(db, config));
  }
  assert.equal(state.created, 0);
});

test("bootstrap locks role mapping in postgres, then atomically migrates/grants only in the app database", async () => {
  const admin = mockAdmin(false);
  const app = mockApplication();
  const connections: string[] = [];
  await bootstrapDatabase(env, async (url, options) => {
    assert.deepEqual(options, { databaseAuth: "entra", mode: "azure", managedIdentityClientId: env.AZURE_CLIENT_ID });
    connections.push(url);
    if (connections.length === 1) return admin.db;
    assert.equal(admin.state.commits, 1, "Role creation must commit before application grants.");
    return app.db;
  });
  assert.equal(new URL(connections[0]!).pathname, "/postgres");
  assert.equal(new URL(connections[1]!).pathname, "/gateway");
  assert.ok(connections.every(url => new URL(url).username === config.migrationPrincipalName));
  assert.ok(admin.state.calls.indexOf("SELECT pg_advisory_xact_lock(706170120)") <
    admin.state.calls.findIndex(sql => sql.includes("pgaadauth_list")));
  assert.ok(app.calls.indexOf("SELECT pg_advisory_xact_lock(706170119)") <
    app.calls.indexOf("SELECT version FROM gateway_migrations"));
  assert.equal(app.commits(), 1);
  assert.equal(admin.state.closed, 1);
  assert.equal(app.closed(), 1);
  assert.deepEqual(app.calls.filter(sql => sql.startsWith("GRANT")), [
    'GRANT CONNECT ON DATABASE "gateway" TO "gateway_app"',
    'GRANT USAGE ON SCHEMA public TO "gateway_app"',
    'GRANT SELECT ON TABLE public."gateway_migrations" TO "gateway_app"',
    ...["teams", "models", "team_months", "reservations", "mcp_servers"]
      .map(table => `GRANT SELECT, INSERT, UPDATE ON TABLE public."${table}" TO "gateway_app"`),
    'GRANT SELECT, INSERT ON TABLE public."audit" TO "gateway_app"',
  ]);
  assert.ok(!app.calls.some(sql => /seed|demo-engineering|TRUNCATE reservations|UPDATE reservations/i.test(sql)));
});

test("committed role stage resumes after a failed app connection without creating another principal", async () => {
  const admin = mockAdmin(false);
  await assert.rejects(bootstrapDatabase(env, async url => {
    if (new URL(url).pathname === "/postgres") return admin.db;
    throw new Error("App database not yet reachable.");
  }));
  assert.equal(admin.state.created, 1);
  assert.equal(admin.state.commits, 1);
  const app = mockApplication();
  await bootstrapDatabase(env, async url => new URL(url).pathname === "/postgres" ? admin.db : app.db);
  assert.equal(admin.state.created, 1);
  assert.equal(app.commits(), 1);
});

test("wrong session, embedded database, and role mapping failure block app initialization and close connections", async () => {
  for (const mode of ["embedded", "wrong-session", "wrong-mapping"]) {
    const admin = mockAdmin();
    if (mode === "embedded") admin.db.kind = "embedded";
    if (mode === "wrong-mapping") admin.state.mappings[1]!.object_id = migrationId;
    if (mode === "wrong-session") admin.db.query = async <T>() => [{ login: "runtime", database: "postgres" }] as T[];
    let connections = 0;
    await assert.rejects(bootstrapDatabase(env, async () => { connections++; return admin.db; }));
    assert.equal(connections, 1);
    assert.equal(admin.state.closed, 1);
  }
});

async function localConfig(db: Database): Promise<BootstrapConfig> {
  // PGlite's active template1 catalog cannot be ACL-updated. A separate catalog
  // database exercises real GRANT/REVOKE; table/ledger SQL runs in the embedded database.
  await db.query("CREATE DATABASE gateway");
  await db.query("CREATE ROLE gateway_app LOGIN");
  return config;
}

test("real PGlite SQL migrations and exact ACLs are idempotent, with no fake production seed", async () => {
  const db = await connectDatabase("pglite://:memory:");
  try {
    const local = await localConfig(db);
    await initializeApplicationDatabase(db, local);
    await initializeApplicationDatabase(db, local);
    assert.deepEqual(await db.query("SELECT version FROM gateway_migrations ORDER BY version"), [{ version: 1 }, { version: 2 }]);
    for (const table of ["teams", "models", "team_months", "reservations", "mcp_servers", "audit"]) {
      assert.deepEqual(await db.query(`SELECT count(*)::int AS count FROM ${table}`), [{ count: 0 }]);
    }
    assert.deepEqual(await db.query(`SELECT
      has_database_privilege('gateway_app','gateway','CONNECT') AS connect,
      has_database_privilege('gateway_app','gateway','TEMP') AS temp,
      has_database_privilege('gateway_app','gateway','CREATE') AS create,
      has_schema_privilege('gateway_app','public','USAGE') AS usage,
      has_schema_privilege('gateway_app','public','CREATE') AS schema_create`),
    [{ connect: true, temp: false, create: false, usage: true, schema_create: false }]);
    const acl = await db.query<{ table_name: string; privilege_type: string; is_grantable: string }>(`SELECT table_name, privilege_type, is_grantable
      FROM information_schema.role_table_grants WHERE grantee='gateway_app' ORDER BY table_name,privilege_type`);
    const expected = {
      audit: ["INSERT", "SELECT"], gateway_migrations: ["SELECT"],
      mcp_servers: ["INSERT", "SELECT", "UPDATE"], models: ["INSERT", "SELECT", "UPDATE"],
      reservations: ["INSERT", "SELECT", "UPDATE"], team_months: ["INSERT", "SELECT", "UPDATE"], teams: ["INSERT", "SELECT", "UPDATE"],
    };
    assert.deepEqual(acl, Object.entries(expected).flatMap(([table_name, permissions]) =>
      permissions.map(privilege_type => ({ table_name, privilege_type, is_grantable: "NO" }))));
    await db.query("SET ROLE gateway_app");
    await assert.rejects(db.query("DELETE FROM audit"));
    await assert.rejects(db.query("UPDATE audit SET detail='tampered'"));
    await assert.rejects(db.query("INSERT INTO gateway_migrations(version) VALUES (1000)"));
    await assert.rejects(db.query("CREATE TABLE unauthorized(id int)"));
    await db.query("RESET ROLE");
  } finally { await db.close(); }
});

test("bootstrap SQL never releases existing held reservations or overwrites the budget ledger", async () => {
  const f = await fixture();
  try {
    await f.reset();
    const reservation = await f.ledger.reserve("demo-engineering", principal.id, chat);
    await f.ledger.held(reservation.id);
    const before = await f.db.query("SELECT * FROM team_months");
    const usage = await f.db.query("SELECT * FROM reservations");
    const local = await localConfig(f.db);
    await initializeApplicationDatabase(f.db, local);
    assert.deepEqual(await f.db.query("SELECT * FROM team_months"), before);
    assert.deepEqual(await f.db.query("SELECT * FROM reservations"), usage);
  } finally { await f.db.close(); }
});

test("incompatible migration versions and failed grants roll back the whole application stage", async () => {
  const db = await connectDatabase("pglite://:memory:");
  try {
    const local = await localConfig(db);
    let failGrant = true;
    const injected: Database = { ...db, transaction: fn => db.transaction(tx => fn({
      query: <T>(sql: string, params?: unknown[]) => {
        if (failGrant && sql.startsWith("GRANT SELECT ON TABLE")) throw new Error("Injected grant failure");
        return tx.query<T>(sql, params);
      },
    })) };
    await assert.rejects(initializeApplicationDatabase(injected, local));
    assert.deepEqual(await db.query("SELECT to_regclass('public.gateway_migrations') AS name"), [{ name: null }]);
    failGrant = false;
    await initializeApplicationDatabase(injected, local);
    await db.query("INSERT INTO gateway_migrations(version) VALUES (999)");
    await assert.rejects(initializeApplicationDatabase(db, local));
    assert.deepEqual(await db.query("SELECT version FROM gateway_migrations ORDER BY version"), [{ version: 1 }, { version: 2 }, { version: 999 }]);
    await db.query("DELETE FROM gateway_migrations WHERE version=999");
    await db.query("GRANT UPDATE(detail) ON audit TO gateway_app");
    await initializeApplicationDatabase(db, local);
    assert.deepEqual(await db.query("SELECT has_any_column_privilege('gateway_app','audit','UPDATE') AS permitted"), [{ permitted: false }]);
    await db.query("GRANT SELECT(detail) ON audit TO gateway_app WITH GRANT OPTION");
    await initializeApplicationDatabase(db, local);
    assert.deepEqual(await db.query("SELECT has_any_column_privilege('gateway_app','audit','SELECT WITH GRANT OPTION') AS permitted"), [{ permitted: false }]);
    await db.query("ALTER TABLE audit OWNER TO gateway_app");
    await assert.rejects(initializeApplicationDatabase(db, local), /must not own/);
  } finally { await db.close(); }
});

test("bootstrap CLI rejects production default/local data paths with sanitized output before networking", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/bootstrap.ts", import.meta.url))], {
    encoding: "utf8", env: { ...process.env, ...env, NODE_ENV: "production", DATABASE_URL: "pglite://data/sensitive-marker" },
    timeout: 20_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes("BOOTSTRAP_FAILED"));
  assert.ok(!`${result.stdout}${result.stderr}`.includes("sensitive-marker"));
});
