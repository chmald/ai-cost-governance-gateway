import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { connectDatabase, type Database } from "../../src/db.js";
import { migrate } from "../../src/migrations.js";
import { seedDemo, Store } from "../../src/store.js";
import { Ledger } from "../../src/ledger.js";
import { ceilCharge } from "../../src/errors.js";
import { chat, principal } from "../helpers.js";

test("real PostgreSQL row locks preserve cap across independent pools/replicas", {
  timeout: 60_000,
}, async () => {
  const source = process.env.TEST_DATABASE_URL;
  if (!source) throw new Error("TEST_DATABASE_URL is required. Use a dedicated PostgreSQL test database; this check must not silently skip.");
  const schema = `gateway_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: source });
  let created = false;
  let first: Database | undefined;
  let second: Database | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    const url = new URL(source);
    url.searchParams.set("options", `-c search_path=${schema}`);
    first = await connectDatabase(url.toString());
    second = await connectDatabase(url.toString());
    await Promise.all([migrate(first), migrate(second)]);
    await seedDemo(first);
    const amount = Number(ceilCharge(8192, 600_000) + ceilCharge(chat.max_completion_tokens, 600_000));
    const store = new Store(first);
    await store.saveTeam({ id: "demo-engineering", name: "Replica test", monthlyBudgetMicros: amount * 5,
      allowedModels: ["demo-chat"], principals: [principal.id] }, principal.id, true);
    const ledgers = [new Ledger(first), new Ledger(second)];
    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) =>
      ledgers[i % 2]!.reserve("demo-engineering", principal.id, chat)));
    const accepted = results.filter(r => r.status === "fulfilled");
    assert.equal(accepted.length, 5);
    assert.equal((await store.teams())[0]!.reservedMicros, amount * 5);
    const reservation = accepted[0]!.value;
    await Promise.all(ledgers.map(l => l.settle(reservation.id, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })));
    const team = (await store.teams())[0]!;
    assert.equal(team.spentMicros, 2);
    assert.equal(team.reservedMicros, amount * 4);
    assert.ok(team.spentMicros + team.reservedMicros <= team.monthlyBudgetMicros);
  } finally {
    await Promise.allSettled([first?.close(), second?.close()]);
    try {
      if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally { await admin.end(); }
  }
});
