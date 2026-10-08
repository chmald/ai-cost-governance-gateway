import type { Database, Sql } from "./db.js";

const migrations = [{
  version: 1,
  statements: [
    `CREATE TABLE teams (id text PRIMARY KEY, config jsonb NOT NULL)`,
    `CREATE TABLE models (id text PRIMARY KEY, deployment_name text NOT NULL UNIQUE, config jsonb NOT NULL)`,
    `CREATE TABLE team_months (
       team_id text NOT NULL REFERENCES teams(id), period text NOT NULL,
       budget bigint NOT NULL CHECK (budget BETWEEN 0 AND 9007199254740991),
       spent bigint NOT NULL DEFAULT 0 CHECK (spent BETWEEN 0 AND 9007199254740991),
       reserved bigint NOT NULL DEFAULT 0 CHECK (reserved BETWEEN 0 AND 9007199254740991),
       PRIMARY KEY (team_id, period), CHECK (spent + reserved <= budget))`,
    `CREATE TABLE reservations (
       id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),
       team_id text NOT NULL, period text NOT NULL, model_id text NOT NULL REFERENCES models(id),
       actor text NOT NULL, snapshot jsonb NOT NULL,
       reserved bigint NOT NULL CHECK (reserved BETWEEN 1 AND 9007199254740991),
       charged bigint CHECK (charged BETWEEN 0 AND 9007199254740991),
       prompt_tokens bigint, completion_tokens bigint,
       status text NOT NULL CHECK (status IN ('reserved','held','settled','invalid_usage')),
       FOREIGN KEY (team_id, period) REFERENCES team_months(team_id, period))`,
    `CREATE INDEX reservations_recent ON reservations(created_at DESC)`,
    `CREATE TABLE mcp_servers (id text PRIMARY KEY, path text NOT NULL UNIQUE, config jsonb NOT NULL)`,
    `CREATE TABLE audit (
       id uuid PRIMARY KEY, timestamp timestamptz NOT NULL DEFAULT now(),
       actor text NOT NULL, action text NOT NULL, target text NOT NULL,
       outcome text NOT NULL, detail text NOT NULL)`,
    `CREATE INDEX audit_recent ON audit(timestamp DESC)`,
  ],
}, {
  // Caller attribution for app-only (managed identity / service principal / agent) callers.
  version: 2,
  statements: [
    `ALTER TABLE reservations ADD COLUMN actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','app'))`,
    `ALTER TABLE reservations ADD COLUMN client_app_id uuid`,
    `ALTER TABLE reservations ADD CONSTRAINT reservations_app_client CHECK (actor_type <> 'app' OR client_app_id IS NOT NULL)`,
    `ALTER TABLE audit ADD COLUMN actor_type text CHECK (actor_type IN ('user','app','system'))`,
  ],
}];

export async function verifySchema(db: Database): Promise<void> {
  const applied = await db.query<{ version: number }>("SELECT version FROM gateway_migrations");
  if (applied.length !== migrations.length || applied.some(row => !migrations.some(m => m.version === row.version))) {
    throw new Error("Database schema is not compatible. Run the explicit migration command before serving traffic.");
  }
}

export async function migrate(db: Database): Promise<void> {
  await db.transaction(tx => migrateInTransaction(tx, db.kind));
}

export async function migrateInTransaction(tx: Sql, kind: Database["kind"]): Promise<void> {
  if (kind === "postgres") await tx.query("SELECT pg_advisory_xact_lock(706170119)");
  await tx.query("CREATE TABLE IF NOT EXISTS gateway_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = await tx.query<{ version: number }>("SELECT version FROM gateway_migrations");
  if (applied.some(r => !migrations.some(m => m.version === r.version))) throw new Error("Database schema is newer than this application.");
  for (const migration of migrations) {
    if (applied.some(row => row.version === migration.version)) continue;
    for (const statement of migration.statements) await tx.query(statement);
    await tx.query("INSERT INTO gateway_migrations(version) VALUES ($1)", [migration.version]);
  }
}
