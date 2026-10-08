import { test, mock } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { runDatabaseCommand } from "../src/cli.js";
import { connectDatabase, verifyRuntimeDatabaseRole } from "../src/db.js";
import { postgresPoolConfig, postgresScope, type DatabaseConnectionOptions } from "../src/database-auth.js";
import { azureConfig } from "./helpers.js";

const clientId = "11111111-1111-4111-8111-111111111111";
const url = "postgresql://gateway_app@safe-server.postgres.database.azure.com:5432/gateway?sslmode=verify-full";
const options: DatabaseConnectionOptions = { mode: "azure", databaseAuth: "entra", managedIdentityClientId: clientId };

test("password remains the default for demo, manual Azure config, and pool configuration", async () => {
  assert.equal(loadConfig({}).databaseAuth, "password");
  assert.equal(azureConfig().databaseAuth, "password");
  const passwordUrl = "postgresql://operator:local-password@localhost/gateway";
  assert.deepEqual(postgresPoolConfig(passwordUrl), {
    connectionString: passwordUrl, max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000,
  });
  const db = await connectDatabase("pglite://:memory:");
  try { assert.equal(db.kind, "embedded"); } finally { await db.close(); }
});

test("Entra config requires explicit Azure mode and identity without echoing unsafe inputs", () => {
  for (const env of [
    { DATABASE_AUTH: "invalid-sensitive-value" },
    { DATABASE_AUTH: "entra" },
    { GATEWAY_MODE: "demo", DATABASE_AUTH: "entra", DATABASE_URL: url, AZURE_CLIENT_ID: clientId },
  ]) {
    assert.throws(() => loadConfig(env), error => error instanceof Error && !error.message.includes("sensitive-value"));
  }
  for (const id of [undefined, "", "not-a-uuid"]) {
    assert.throws(() => azureConfig({ DATABASE_AUTH: "entra", DATABASE_URL: url, AZURE_CLIENT_ID: id }));
  }
  assert.equal(azureConfig({ DATABASE_AUTH: "entra", DATABASE_URL: url, AZURE_CLIENT_ID: clientId }).databaseAuth, "entra");
});

test("Entra rejects URL passwords, TLS overrides, endpoint/query redirects, and demo paths before identity", async () => {
  const unsafe = [
    "pglite://data/gateway", "not a URL", "postgresql://",
    url.replace("gateway_app@", "gateway_app:sensitive-password@"),
    url.replace("safe-server.postgres.database.azure.com", "localhost"),
    url.replace("safe-server.postgres.database.azure.com", "safe-server.postgres.database.azure.com.evil.test"),
    url.replace(":5432", ":6543"), url.replace("/gateway?", "/gateway%2Fother?"),
    url.replace("verify-full", "require"), `${url}&sslmode=disable`, `${url}&ssl=false`,
    `${url}&host=evil.test`, `${url}&password=sensitive-password`, `${url}&user=admin`,
    `${url}&options=-csearch_path=evil`, `${url}#sensitive-password`, url.replace("gateway_app@", "@"),
  ];
  for (const value of unsafe) {
    let credentials = 0;
    await assert.rejects(connectDatabase(value, options, () => { credentials++; throw new Error("Should not reach identity"); }),
      error => error instanceof Error && !error.message.includes("sensitive-password"));
    assert.equal(credentials, 0);
  }
  for (const mode of [undefined, "demo"] as const) {
    assert.throws(() => postgresPoolConfig(url, { ...options, mode }));
  }
});

test("pool callback obtains PostgreSQL scope per new connection using only the selected identity", async () => {
  const requests: string[] = [];
  const clients: string[] = [];
  const config = postgresPoolConfig(url, options, id => {
    clients.push(id);
    return { getToken: async scope => {
      requests.push(scope);
      return { token: `ephemeral-${requests.length}`, expiresOnTimestamp: Date.now() + 60_000 };
    } };
  });
  assert.equal(config.connectionString, undefined);
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.deepEqual([config.host, config.port, config.user, config.database],
    ["safe-server.postgres.database.azure.com", 5432, "gateway_app", "gateway"]);
  assert.equal(requests.length, 0, "Configuration must not eagerly acquire a token.");
  for (let index = 1; index <= 3; index++) {
    // Exercise the real pg Client parser: a passwordless connectionString must not erase the callback.
    const client = new pg.Client(config);
    const password = client.password;
    assert.equal(typeof password, "function");
    assert.equal(await (password as unknown as () => Promise<string>)(), `ephemeral-${index}`);
  }
  assert.deepEqual(clients, [clientId]);
  assert.deepEqual(requests, [postgresScope, postgresScope, postgresScope]);
  assert.ok(!JSON.stringify(config).includes("ephemeral"));
});

test("missing, expired, and failed tokens fail closed without diagnostics or credential fallback", async () => {
  for (const result of [null, { token: "", expiresOnTimestamp: Date.now() + 60_000 },
    { token: "sensitive-token", expiresOnTimestamp: 0 }, { token: "sensitive-token", expiresOnTimestamp: NaN }, "error"]) {
    let attempts = 0;
    const config = postgresPoolConfig(url, options, () => ({
      getToken: async () => {
        attempts++;
        if (typeof result === "string") throw new Error("sensitive-token from identity endpoint");
        return result;
      },
    }));
    await assert.rejects((config.password as () => Promise<string>)(), error =>
      error instanceof Error && !error.message.includes("sensitive") && !error.cause);
    assert.equal(attempts, 1);
  }
});

test("connectDatabase forwards the selected auth callback to pg.Pool and closes a failed pool", async () => {
  let ended = 0;
  let identities = 0;
  const replacement = mock.method(pg, "Pool", function (config: pg.PoolConfig) {
    assert.equal(config.connectionString, undefined);
    return {
      on: () => {},
      query: async () => { await (config.password as () => Promise<string>)(); return { rows: [{ result: 1 }] }; },
      end: async () => { ended++; },
    };
  });

  try {
    const factory = () => ({ getToken: async () => {
      identities++;
      return { token: "mock-token", expiresOnTimestamp: Date.now() + 60_000 };
    } });
    const db = await connectDatabase(url, options, factory);
    await db.query("SELECT 1");
    await db.close();
    assert.equal(identities, 2);
    await assert.rejects(connectDatabase(url, options, () => ({ getToken: async () => {
      throw new Error("sensitive-token");
    } })), error => error instanceof Error && !error.message.includes("sensitive-token"));
    assert.equal(ended, 2);
  } finally { replacement.mock.restore(); }
});

test("Entra credential initialization and database errors never retain sensitive driver diagnostics", async () => {
  assert.throws(() => postgresPoolConfig(url, options, () => { throw new Error("sensitive-token"); }),
    error => error instanceof Error && !error.message.includes("sensitive-token"));
  const replacement = mock.method(pg, "Pool", function () {
    return { on: () => {}, query: async () => { throw new Error("sensitive-token postgres response"); }, end: async () => {} };
  });
  try {
    await assert.rejects(connectDatabase(url, options, () => ({ getToken: async () => null })),
      error => error instanceof Error && !error.message.includes("sensitive-token") && !error.cause);
  } finally { replacement.mock.restore(); }
});

test("runtime role check is read-only and rejects administrator, owning, or inherited role access", async () => {
  const db = await connectDatabase("pglite://:memory:");
  try {
    await assert.rejects(verifyRuntimeDatabaseRole(db), /unprivileged/);
    await db.query("CREATE ROLE gateway_app LOGIN");
    await db.query("SET ROLE gateway_app");
    await verifyRuntimeDatabaseRole(db);
    await db.query("RESET ROLE");
    await db.query("CREATE ROLE other_role");
    await db.query("GRANT other_role TO gateway_app");
    await db.query("SET ROLE gateway_app");
    await assert.rejects(verifyRuntimeDatabaseRole(db), /unprivileged/);
    await db.query("RESET ROLE");
  } finally { await db.close(); }
});

test("existing migrate CLI selects Entra or password auth while Azure seed fails before connection", async () => {
  for (const databaseAuth of ["password", "entra"] as const) {
    const config = azureConfig({ DATABASE_AUTH: databaseAuth, DATABASE_URL: url, AZURE_CLIENT_ID: clientId });
    const db = await connectDatabase("pglite://:memory:");
    let connections = 0;
    const connect: typeof connectDatabase = async (databaseUrl, options) => {
      connections++;
      assert.equal(databaseUrl, url);
      assert.equal(options, config);
      return { ...db, close: async () => {} };
    };
    try {
      await assert.rejects(runDatabaseCommand("seed", config, connect), /prohibited/);
      assert.equal(connections, 0);
      await runDatabaseCommand("migrate", config, connect);
      assert.equal(connections, 1);
      assert.deepEqual(await db.query("SELECT version FROM gateway_migrations ORDER BY version"), [{ version: 1 }, { version: 2 }]);
      assert.deepEqual(await db.query("SELECT count(*)::int AS count FROM teams"), [{ count: 0 }]);
    } finally { await db.close(); }
  }
});
