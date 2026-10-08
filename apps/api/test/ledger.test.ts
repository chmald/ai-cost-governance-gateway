import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture, chat, principal, agent } from "./helpers.js";
import { ceilCharge, GatewayError } from "../src/errors.js";
import { Inference, simulated } from "../src/inference.js";
import { connectDatabase } from "../src/db.js";
import { migrate } from "../src/migrations.js";
import { projectRoot } from "../src/config.js";
import { seedDemo } from "../src/store.js";
import { Ledger } from "../src/ledger.js";

let f: Awaited<ReturnType<typeof fixture>>;
before(async () => { f = await fixture(); });
beforeEach(async () => f.reset());
after(async () => f.db.close());
const code = (expected: string) => (e: unknown) => e instanceof GatewayError && e.code === expected;
const teamInput = async (budget: number) => {
  const t = (await f.store.teams())[0]!;
  return { id: t.id, name: t.name, principals: t.principals, allowedModels: t.allowedModels, monthlyBudgetMicros: budget };
};
const appCaller = { id: agent.id, type: "app" as const, clientAppId: agent.clientAppId };
const registerAgent = async (budget = 25_000_000) =>
  f.store.saveTeam({ ...(await teamInput(budget)), applications: [agent.id] }, principal.id, true);

test("app-only callers are admitted only when registered to the team and are attributed as applications", async () => {
  await assert.rejects(f.ledger.reserve("demo-engineering", appCaller, chat), code("TEAM_ACCESS_DENIED"));
  await registerAgent();
  // A user principal list never authorizes an application with the same object ID, and vice versa.
  await assert.rejects(f.ledger.reserve("demo-engineering", { id: principal.id, type: "app", clientAppId: agent.clientAppId }, chat), code("TEAM_ACCESS_DENIED"));
  await assert.rejects(f.ledger.reserve("demo-engineering", agent.id, chat), code("TEAM_ACCESS_DENIED"));
  await assert.rejects(f.ledger.reserve("demo-research", appCaller, chat), code("TEAM_ACCESS_DENIED"));
  await assert.rejects(f.ledger.reserve("demo-engineering", { id: agent.id, type: "app" }, chat));
  const r = await f.ledger.reserve("demo-engineering", appCaller, chat);
  assert.equal(r.actor, agent.id);
  assert.equal(r.actor_type, "app");
  assert.equal(r.client_app_id, agent.clientAppId);
  await f.ledger.settle(r.id, { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
  const usage = (await f.store.usage())[0]!;
  assert.deepEqual([usage.actorId, usage.actorType, usage.clientAppId, usage.status], [agent.id, "app", agent.clientAppId, "settled"]);
  const audits = (await f.store.audits()) as { action: string; actor: string; actorType: string; detail: string }[];
  for (const action of ["inference.reserve", "inference.settle"]) {
    const entry = audits.find(a => a.action === action)!;
    assert.deepEqual([entry.actor, entry.actorType], [agent.id, "app"]);
  }
  assert.ok(audits.find(a => a.action === "inference.reserve")!.detail.includes(`clientAppId=${agent.clientAppId}`));
  const userRow = await f.ledger.reserve("demo-engineering", principal.id, chat);
  assert.deepEqual([userRow.actor_type, userRow.client_app_id], ["user", null]);
});

test("prepaid budget is enforced for app-only callers, including their held reservations", async () => {
  const amount = ceilCharge(8192, 600_000) + ceilCharge(chat.max_completion_tokens, 600_000);
  await registerAgent(Number(amount) * 2);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => f.ledger.reserve("demo-engineering", appCaller, chat)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 2);
  assert.ok(results.filter(r => r.status === "rejected").every(r => code("BUDGET_EXCEEDED")((r as PromiseRejectedResult).reason)));
  await assert.rejects(f.ledger.reserve("demo-engineering", principal.id, chat), code("BUDGET_EXCEEDED"));
  const team = (await f.store.teams())[0]!;
  assert.equal(team.reservedMicros, Number(amount) * 2);
});

test("team application registrations are validated, disjoint from users, and preserved when omitted", async () => {
  const saved = await registerAgent();
  assert.deepEqual(saved.applications, [agent.id]);
  await f.store.saveTeam(await teamInput(25_000_000), principal.id, true);
  assert.deepEqual((await f.store.teams())[0]!.applications, [agent.id]);
  await assert.rejects(f.store.saveTeam({ ...(await teamInput(1)), applications: [principal.id] }, principal.id, true), code("PRINCIPAL_CONFLICT"));
  await assert.rejects(f.store.saveTeam({ ...(await teamInput(1)), applications: ["not-a-guid"] }, principal.id, true));
  await f.store.saveTeam({ ...(await teamInput(25_000_000)), applications: [] }, principal.id, true);
  assert.deepEqual((await f.store.teams())[0]!.applications, []);
  assert.deepEqual((await f.store.teams(appCaller)).map(t => t.id), []);
});

test("BigInt charging rounds up without floating-point precision loss", () => {
  assert.equal(ceilCharge(1, 1), 1n);
  assert.equal(ceilCharge(3, 333_334), 2n);
  assert.equal(ceilCharge(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    (BigInt(Number.MAX_SAFE_INTEGER) ** 2n + 999_999n) / 1_000_000n);
  for (const n of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => ceilCharge(n, 1));
  assert.throws(() => ceilCharge(1, 0));
});

test("atomic concurrent reservations count all held money, never oversubscribe cap", async () => {
  const amount = ceilCharge(8192, 600_000) + ceilCharge(chat.max_completion_tokens, 600_000);
  await f.store.saveTeam(await teamInput(Number(amount) * 3), principal.id, true);
  const results = await Promise.allSettled(Array.from({ length: 24 }, () => f.ledger.reserve("demo-engineering", principal.id, chat)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 3);
  const team = (await f.store.teams())[0]!;
  assert.equal(team.reservedMicros, Number(amount) * 3);
  assert.equal(team.spentMicros, 0);
  assert.ok(team.reservedMicros <= team.monthlyBudgetMicros);
});

test("settlement is idempotent and immutable snapshot pricing wins over changes", async () => {
  const reserved = await f.ledger.reserve("demo-engineering", principal.id, chat);
  const model = (await f.store.models())[0]!;
  const { displayName, contextWindowTokens, maxOutputTokens, pricingValidUntil, enabled } = model;
  await f.store.updateModel(model.id, {
    displayName, contextWindowTokens, maxOutputTokens, pricingValidUntil, enabled,
    inputPriceMicrosPerMillion: 9_000_000, outputPriceMicrosPerMillion: 9_000_000,
  }, principal.id);
  const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
  const settlements = await Promise.all(Array.from({ length: 8 }, () => f.ledger.settle(reserved.id, usage)));
  assert.ok(settlements.every(s => s.chargedMicros === 8));
  const team = (await f.store.teams())[0]!;
  assert.equal(team.spentMicros, 8);
  assert.equal(team.reservedMicros, 0);
  assert.equal((await f.store.audits()).filter(a => a.action === "inference.settle").length, 1);
});

test("monthly rollover settles original month and does not consume next month", async () => {
  f.setDate("2026-09-30T23:59:59.999Z");
  const r = await f.ledger.reserve("demo-engineering", principal.id, chat);
  f.setDate("2026-10-01T00:00:00.001Z");
  await f.ledger.settle(r.id, { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
  const next = (await f.store.teams())[0]!;
  assert.equal(next.period, "2026-10");
  assert.equal(next.spentMicros, 0);
  const rows = await f.db.query<{ period: string; spent: string }>("SELECT period,spent FROM team_months");
  assert.equal(rows[0]!.period, "2026-09");
  assert.equal(Number(rows[0]!.spent), 8);
});

test("budget cannot be reduced below spent plus reserved", async () => {
  const r = await f.ledger.reserve("demo-engineering", principal.id, chat);
  await assert.rejects(f.store.saveTeam(await teamInput(Number(r.reserved) - 1), principal.id, true), code("BUDGET_COMMITTED"));
  await f.ledger.settle(r.id, { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
  await assert.rejects(f.store.saveTeam(await teamInput(7), principal.id, true), code("BUDGET_COMMITTED"));
});

test("stale, disabled, unknown, unauthorized, and over-context requests never reserve", async () => {
  await assert.rejects(f.ledger.reserve("demo-engineering", randomUUID(), chat), code("TEAM_ACCESS_DENIED"));
  await assert.rejects(f.ledger.reserve("not-a-team", principal.id, chat), code("TEAM_ACCESS_DENIED"));
  await assert.rejects(f.ledger.reserve("demo-engineering", principal.id, { ...chat, model: "unknown" }), code("UNKNOWN_MODEL"));
  await assert.rejects(f.ledger.reserve("demo-engineering", principal.id, { ...chat, max_completion_tokens: 2049 }), code("CONTEXT_LIMIT"));
  await assert.rejects(f.ledger.reserve("demo-engineering", principal.id, { ...chat, messages: [{ role: "user", content: "🍀".repeat(2000) }] }), code("CONTEXT_LIMIT"));
  f.setDate("2100-01-01T00:00:00.000Z");
  await assert.rejects(f.ledger.reserve("demo-engineering", principal.id, chat), code("STALE_PRICING"));
  assert.equal((await f.store.usage()).length, 0);
});

test("membership mutation is serialized with admission", async () => {
  const r = await f.ledger.reserve("demo-engineering", principal.id, chat);
  const t = await teamInput(25_000_000);
  await f.store.saveTeam({ ...t, principals: [] }, principal.id, true);
  await assert.rejects(f.ledger.reserve("demo-engineering", principal.id, chat), code("TEAM_ACCESS_DENIED"));
  const settled = await f.ledger.settle(r.id, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  assert.equal(settled.chargedMicros, 2);
});

test("provider timeout retains full reservation with no retry", async () => {
  let calls = 0;
  const engine = new Inference(f.ledger, { infer: async () => { calls++; throw new Error("timeout"); } });
  await assert.rejects(engine.execute("demo-engineering", principal, chat), code("RESERVATION_HELD"));
  assert.equal(calls, 1);
  const usage = await f.store.usage();
  assert.equal(usage[0]!.status, "held");
  assert.equal((await f.store.teams())[0]!.reservedMicros, usage[0]!.reservedMicros);
});

test("missing usage or invalid provider body is explicitly held, never released", async () => {
  for (const response of [{ id: "bad" }, { ...simulated(chat), choices: [] }]) {
    const engine = new Inference(f.ledger, { infer: async () => response });
    await assert.rejects(engine.execute("demo-engineering", principal, chat), code("RESERVATION_HELD"));
  }
  assert.equal((await f.store.usage()).filter(r => r.status === "held").length, 2);
});

test("unsafe or excessive provider usage keeps reserve and quarantines model", async () => {
  for (const usage of [
    { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER + 2 },
    { prompt_tokens: 1, completion_tokens: 500_000, total_tokens: 500_001 },
    { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 },
  ]) {
    await f.reset();
    const r = await f.ledger.reserve("demo-engineering", principal.id, chat);
    await assert.rejects(f.ledger.settle(r.id, usage), code("INVALID_USAGE_RESERVATION_HELD"));
    assert.equal((await f.store.teams())[0]!.reservedMicros, Number(r.reserved));
    assert.equal((await f.store.models())[0]!.quarantined, true);
    await assert.rejects(f.ledger.reserve("demo-engineering", principal.id, chat), code("MODEL_DISABLED"));
    await assert.rejects(f.ledger.settle(r.id, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }), code("INVALID_USAGE_RESERVATION_HELD"));
  }
});

test("storage failure rejects admission before provider invocation", async () => {
  let calls = 0;
  const broken = { ...f.db, transaction: async () => { throw new Error("database offline"); } };
  const engine = new Inference(new Ledger(broken), { infer: async input => { calls++; return simulated(input); } });
  await assert.rejects(engine.execute("demo-engineering", principal, chat));
  assert.equal(calls, 0);
});

test("idempotent migrations and demo seeding preserve existing data", async () => {
  await f.ledger.reserve("demo-engineering", principal.id, chat);
  await migrate(f.db);
  await seedDemo(f.db);
  assert.equal((await f.store.usage()).length, 1);
  assert.equal((await f.store.teams()).length, 2);
});

test("embedded ledger is durable across reopen, including crash-like in-flight reservation", async () => {
  const path = `data/api-test-${randomUUID()}`;
  let db = await connectDatabase(`pglite://${path}`);
  try {
    await assert.rejects(connectDatabase(`pglite://${path}`), "A second process/instance must not open the same embedded data directory.");
    await migrate(db);
    await seedDemo(db);
    const r = await new Ledger(db).reserve("demo-engineering", principal.id, chat);
    await db.close();
    db = await connectDatabase(`pglite://${path}`);
    const [saved] = await db.query<{ status: string; reserved: string }>("SELECT status,reserved FROM reservations WHERE id=$1", [r.id]);
    assert.equal(saved!.status, "reserved");
    assert.equal(String(saved!.reserved), String(r.reserved));
  } finally {
    await db.close();
    await rm(resolve(projectRoot, path), { recursive: true, force: true });
    await rm(resolve(projectRoot, `${path}.gateway.lock`), { force: true });
  }
});
