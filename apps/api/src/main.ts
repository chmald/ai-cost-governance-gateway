import { loadRuntimeConfig } from "./config.js";
import { connectDatabase, verifyRuntimeDatabaseRole } from "./db.js";
import { migrate, verifySchema } from "./migrations.js";
import { seedDemo } from "./store.js";
import { buildApp } from "./app.js";
import { operationalError } from "./errors.js";

async function main() {
  const config = loadRuntimeConfig();
  const db = await connectDatabase(config.databaseUrl, config);
  try {
    if (config.mode === "demo") {
      await migrate(db);
      await seedDemo(db);
    } else {
      if (config.databaseAuth === "entra") await verifyRuntimeDatabaseRole(db);
      await verifySchema(db);
    }
    const app = await buildApp({ config, db });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
    };
    const shutdown = () => { void stop().catch(() => {
      operationalError("gateway.shutdown", "CLOSE_FAILED");
      process.exitCode = 1;
    }); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    try {
      await app.listen({ host: config.host, port: config.port });
    } catch (error) { await app.close(); throw error; }
    console.info(`Gateway listening on ${config.host}:${config.port} (${config.mode}${config.mode === "demo" ? " — FAKE DATA / SIMULATED INFERENCE / LOOPBACK ONLY" : ""}).`);
  } catch (error) {
    await db.close().catch(() => { operationalError("gateway.startup_cleanup", "CLOSE_FAILED"); });
    throw error;
  }
}

main().catch(() => {
  // Configuration/driver errors can contain connection strings. Never print the raw error.
  console.error("Gateway startup failed. Check validated configuration, database access, and migration compatibility.");
  process.exitCode = 1;
});
