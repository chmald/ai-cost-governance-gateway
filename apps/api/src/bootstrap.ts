import { pathToFileURL } from "node:url";
import { connectDatabase, type Database, type Sql } from "./db.js";
import { postgresHostPattern, postgresLoginPattern, postgresNamePattern, uuidPattern } from "./database-auth.js";
import { fail, operationalError } from "./errors.js";
import { migrateInTransaction, verifySchema } from "./migrations.js";

export interface BootstrapConfig {
  host: string;
  database: string;
  appRole: string;
  migrationPrincipalName: string;
  runtimePrincipalId: string;
  managedIdentityClientId: string;
}

function invalid(message: string): never {
  return fail(500, "DATABASE_BOOTSTRAP_INVALID", message);
}

export function loadBootstrapConfig(env: NodeJS.ProcessEnv): BootstrapConfig {
  if (env.GATEWAY_MODE !== "azure" || env.DATABASE_AUTH !== "entra") {
    invalid("Bootstrap requires explicit GATEWAY_MODE=azure and DATABASE_AUTH=entra.");
  }
  // This entry point never loads .env or falls back to DATABASE_URL/local demo storage.
  if (env.DATABASE_URL) invalid("Bootstrap uses POSTGRES_* inputs; do not supply DATABASE_URL.");
  const cfg = {
    host: env.POSTGRES_HOST || "", database: env.POSTGRES_DATABASE || "",
    appRole: env.POSTGRES_APP_ROLE || "", migrationPrincipalName: env.MIGRATION_PRINCIPAL_NAME || "",
    runtimePrincipalId: env.RUNTIME_PRINCIPAL_ID || "", managedIdentityClientId: env.AZURE_CLIENT_ID || "",
  };
  if (!postgresHostPattern.test(cfg.host)) invalid("POSTGRES_HOST must be an Azure PostgreSQL server FQDN.");
  for (const name of [cfg.database, cfg.appRole]) {
    if (!postgresNamePattern.test(name) || /^(?:pg_|azure_|template[01]$|postgres$|public$)/.test(name)) {
      invalid("POSTGRES_DATABASE and POSTGRES_APP_ROLE must be safe, non-system PostgreSQL names.");
    }
  }
  if (!postgresLoginPattern.test(cfg.migrationPrincipalName) || cfg.migrationPrincipalName === cfg.appRole) {
    invalid("MIGRATION_PRINCIPAL_NAME must be a safe login distinct from the runtime role.");
  }
  if (!uuidPattern.test(cfg.runtimePrincipalId) || !uuidPattern.test(cfg.managedIdentityClientId)) {
    invalid("RUNTIME_PRINCIPAL_ID and AZURE_CLIENT_ID must be valid identity UUIDs.");
  }
  return cfg;
}

interface EntraPrincipal {
  rolename: string;
  principal_type: string;
  object_id: string;
  tenant_id: string;
  is_mfa: number;
  is_admin: number;
}
interface Role {
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
}

async function principals(tx: Sql): Promise<EntraPrincipal[]> {
  // Alias the documented output positions: the extension uses mixed-case column names.
  return tx.query<EntraPrincipal>(`SELECT * FROM pg_catalog.pgaadauth_list_principals(false)
    AS p(rolename, principal_type, object_id, tenant_id, is_mfa, is_admin)`);
}

async function runtimeRole(tx: Sql, name: string): Promise<Role | undefined> {
  const rows = await tx.query<Role>(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
    FROM pg_catalog.pg_roles WHERE rolname = $1`, [name]);
  return rows[0];
}

async function assertUnprivilegedRole(tx: Sql, name: string, role: Role | undefined): Promise<void> {
  if (!role || role.rolcanlogin !== true ||
      [role.rolsuper, role.rolcreatedb, role.rolcreaterole, role.rolreplication, role.rolbypassrls].some(flag => flag !== false)) {
    invalid("Runtime role is missing, cannot log in, or has elevated PostgreSQL attributes.");
  }
  const memberships = await tx.query(`SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.member WHERE r.rolname = $1`, [name]);
  if (memberships.length) invalid("Runtime role must not inherit or assume any other PostgreSQL role.");
}

export async function ensureRuntimeRole(tx: Sql, config: BootstrapConfig, allowCreate = true): Promise<void> {
  const rows = await principals(tx);
  const administrator = rows.find(row => row.rolename === config.migrationPrincipalName);
  if (!administrator || administrator.principal_type !== "service" || administrator.is_admin !== 1 ||
      !uuidPattern.test(administrator.object_id)) {
    invalid("Migration login must already be the provisioned PostgreSQL Entra service administrator.");
  }
  const runtimeId = config.runtimePrincipalId.toLowerCase();
  if (rows.some(row => row.object_id.toLowerCase() === runtimeId &&
      (row.rolename !== config.appRole || row.is_admin !== 0))) {
    invalid("Runtime identity is mapped to an administrator or another PostgreSQL role.");
  }
  const existing = rows.find(row => row.rolename === config.appRole);
  const role = await runtimeRole(tx, config.appRole);
  if (existing) {
    if (existing.object_id.toLowerCase() !== runtimeId || existing.principal_type !== "service" ||
        existing.is_admin !== 0 || existing.is_mfa !== 0 ||
        existing.tenant_id.toLowerCase() !== administrator.tenant_id.toLowerCase()) {
      invalid("Existing runtime role has a different or unsafe Entra principal mapping; no remapping is permitted.");
    }
    await assertUnprivilegedRole(tx, config.appRole, role);
    return;
  }
  if (role) invalid("Existing runtime role is not mapped to the required Entra principal; no remapping is permitted.");
  if (!allowCreate) invalid("PostgreSQL did not create the required Entra runtime role.");
  await tx.query("SELECT * FROM pg_catalog.pgaadauth_create_principal_with_oid($1, $2, 'service', false, false)",
    [config.appRole, config.runtimePrincipalId]);
  // Verify the extension's actual result instead of trusting a success message.
  await ensureRuntimeRole(tx, config, false);
}

const mutableTables = ["teams", "models", "team_months", "reservations", "mcp_servers"];
const tablePermissions: Record<string, string[]> = {
  gateway_migrations: ["SELECT"], ...Object.fromEntries(mutableTables.map(name => [name, ["SELECT", "INSERT", "UPDATE"]])),
  audit: ["SELECT", "INSERT"],
};
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function grantRuntimeAccess(tx: Sql, config: BootstrapConfig): Promise<void> {
  await assertUnprivilegedRole(tx, config.appRole, await runtimeRole(tx, config.appRole));
  const [ownership] = await tx.query<{ owns_objects: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid=d.datdba
      WHERE r.rolname=$1 AND d.datname=current_database())
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner WHERE r.rolname=$1)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE r.rolname=$1)
    AS owns_objects`, [config.appRole]);
  if (!ownership || ownership.owns_objects !== false) invalid("Runtime role must not own the database, schemas, or tables.");
  const role = identifier(config.appRole);
  const database = identifier(config.database);
  await tx.query(`REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM PUBLIC, ${role}`);
  await tx.query(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC, ${role}`);
  await tx.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, ${role}`);
  await tx.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, ${role}`);
  await tx.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  for (const [table, permissions] of Object.entries(tablePermissions)) {
    await tx.query(`GRANT ${permissions.join(", ")} ON TABLE public.${identifier(table)} TO ${role}`);
  }
  // Verify effective privileges too: a different grantor's column/table grants can survive REVOKE.
  for (const [table, allowed] of Object.entries(tablePermissions)) {
    for (const permission of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      const columnCheck = ["SELECT", "INSERT", "UPDATE", "REFERENCES"].includes(permission)
        ? " OR has_any_column_privilege($1, $2, $3)" : "";
      const columnGrantCheck = columnCheck ? " OR has_any_column_privilege($1, $2, $3 || ' WITH GRANT OPTION')" : "";
      const [actual] = await tx.query<{ permitted: boolean; grantable: boolean }>(`SELECT
        (has_table_privilege($1, $2, $3)${columnCheck}) AS permitted,
        (has_table_privilege($1, $2, $3 || ' WITH GRANT OPTION')${columnGrantCheck}) AS grantable`,
      [config.appRole, `public.${table}`, permission]);
      if (!actual || actual.permitted !== allowed.includes(permission) || actual.grantable !== false) {
        invalid("Runtime table permissions differ from the required least-privilege policy.");
      }
    }
  }
}

export async function initializeApplicationDatabase(db: Database, config: BootstrapConfig): Promise<void> {
  await db.transaction(async tx => {
    await tx.query("SET LOCAL search_path = public");
    await migrateInTransaction(tx, db.kind);
    await grantRuntimeAccess(tx, config);
  });
  await verifySchema(db);
}

async function assertSession(db: Database, config: BootstrapConfig, database: string): Promise<void> {
  if (db.kind !== "postgres") invalid("Bootstrap requires PostgreSQL; embedded storage is forbidden.");
  const [session] = await db.query<{ login: string; database: string }>(
    "SELECT session_user::text AS login, current_database() AS database");
  if (session?.login !== config.migrationPrincipalName || session.database !== database) {
    invalid("Bootstrap connected to an unexpected PostgreSQL login or database.");
  }
}

export async function bootstrapDatabase(
  env: NodeJS.ProcessEnv = process.env,
  connect: typeof connectDatabase = connectDatabase,
): Promise<void> {
  const config = loadBootstrapConfig(env);
  const options = { databaseAuth: "entra" as const, mode: "azure" as const, managedIdentityClientId: config.managedIdentityClientId };
  const url = (database: string) => `postgresql://${config.migrationPrincipalName}@${config.host}:5432/${database}?sslmode=verify-full`;
  const admin = await connect(url("postgres"), options);
  try {
    await assertSession(admin, config, "postgres");
    await admin.transaction(async tx => {
      // All jobs map server-wide roles in postgres under the same transaction lock.
      await tx.query("SELECT pg_advisory_xact_lock(706170120)");
      await ensureRuntimeRole(tx, config);
    });
  } finally { await admin.close(); }
  // Commit the role before connecting to the Bicep-created database. A failed second
  // stage can resume safely; migrations and grants commit together under the migration lock.
  const app = await connect(url(config.database), options);
  try {
    await assertSession(app, config, config.database);
    await initializeApplicationDatabase(app, config);
  } finally { await app.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapDatabase().then(() => {
    console.info("PostgreSQL Entra runtime mapping, versioned migrations, and least-privilege grants verified.");
  }).catch(() => {
    operationalError("database.bootstrap", "BOOTSTRAP_FAILED");
    console.error("Database bootstrap failed. Check explicit Azure/Entra job inputs, migration administrator access, runtime role mapping, and schema permissions.");
    process.exitCode = 1;
  });
}
