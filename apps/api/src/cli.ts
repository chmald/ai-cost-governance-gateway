import { pathToFileURL } from "node:url";
import { loadRuntimeConfig, type Config } from "./config.js";
import { connectDatabase } from "./db.js";
import { migrate } from "./migrations.js";
import { seedDemo } from "./store.js";

export async function runDatabaseCommand(
  command: string | undefined,
  config: Config,
  connect: typeof connectDatabase = connectDatabase,
): Promise<void> {
  if (!["migrate", "seed"].includes(command || "")) throw new Error("Expected migrate or seed.");
  if (command === "seed" && config.mode !== "demo") throw new Error("Fake seed data is prohibited in Azure mode.");
  const db = await connect(config.databaseUrl, config);
  try {
    await migrate(db);
    if (command === "seed") await seedDemo(db);
    console.info(command === "seed" ? "Fake local demo seed applied idempotently." : "Versioned database migrations applied.");
  } finally { await db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => runDatabaseCommand(process.argv[2], loadRuntimeConfig())).catch(() => {
    console.error("Database command failed. Check mode, configuration, and database access.");
    process.exitCode = 1;
  });
}
