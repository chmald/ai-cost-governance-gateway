import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { ceilCharge, fail, safeNumber } from "./errors.js";
import { completion, identifier, inputBound, modelCreate, principalId, supportedDeployment, type Caller, type ChatInput, type Model, type Team } from "./schemas.js";
import { asCaller, audit, ensureMonth, isTeamMember, month, type MonthRow } from "./store.js";

export type Snapshot = {
  inputRate: number; outputRate: number; contextWindowTokens: number;
  maxCompletionTokens: number; inputBoundTokens: number; deploymentName: string; modelVersion: string;
};
export type Reservation = {
  id: string; team_id: string; model_id: string; period: string; actor: string;
  actor_type: "user" | "app"; client_app_id: string | null;
  snapshot: Snapshot; reserved: string; charged: string | null; status: string;
  prompt_tokens: string | null; completion_tokens: string | null;
};
export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export class Ledger {
  constructor(private db: Database, private now: () => Date = () => new Date()) {}

  async reserve(teamId: string, principal: string | Caller, raw: ChatInput): Promise<Reservation> {
    identifier.parse(teamId);
    const caller = asCaller(principal);
    principalId.parse(caller.id);
    if (caller.type === "app") principalId.parse(caller.clientAppId);
    const input = completion.parse(raw);
    return this.db.transaction(async tx => {
      // Every operation touching these rows takes locks in model -> team -> month -> reservation order.
      const [modelRow] = await tx.query<{ config: Model }>("SELECT config FROM models WHERE id=$1 FOR UPDATE", [input.model]);
      if (!modelRow) return fail(404, "UNKNOWN_MODEL", "Unknown model.");
      const model = modelRow.config;
      if (!model.enabled || model.quarantined || !supportedDeployment(model) || !["Succeeded", "demo"].includes(model.status)) {
        fail(403, "MODEL_DISABLED", "Model is disabled, quarantined, or not ready.");
      }
      modelCreate.parse(Object.fromEntries(Object.entries(model).filter(([k]) => !["status", "quarantined", "format"].includes(k))));
      const [teamRow] = await tx.query<{ config: Team }>("SELECT config FROM teams WHERE id=$1 FOR UPDATE", [teamId]);
      if (!teamRow || !isTeamMember(teamRow.config, caller) || !teamRow.config.allowedModels.includes(model.id)) {
        fail(403, "TEAM_ACCESS_DENIED", caller.type === "app"
          ? "Application identity is not registered to this team or the model is not allowed."
          : "Principal is not a member of this team or the model is not allowed.");
      }
      const at = this.now();
      if (Date.parse(model.pricingValidUntil) <= at.getTime()) fail(409, "STALE_PRICING", "Model pricing has expired; an administrator must verify it.");
      const bound = inputBound(input);
      if (input.max_completion_tokens > model.maxOutputTokens ||
          bound + input.max_completion_tokens > model.contextWindowTokens) {
        fail(400, "CONTEXT_LIMIT", "Conservative input bound plus requested output exceeds verified model limits.");
      }
      const period = month(at);
      const ledger = await ensureMonth(tx, teamRow.config, period);
      const maximumRate = Math.max(model.inputPriceMicrosPerMillion, model.outputPriceMicrosPerMillion);
      // Reserve a full context at the larger rate PLUS a separately bounded output allowance.
      const reserved = ceilCharge(model.contextWindowTokens, maximumRate) +
        ceilCharge(input.max_completion_tokens, model.outputPriceMicrosPerMillion);
      safeNumber(reserved);
      if (BigInt(ledger.spent) + BigInt(ledger.reserved) + reserved > BigInt(ledger.budget)) {
        fail(402, "BUDGET_EXCEEDED", "Insufficient prepaid monthly budget, including existing held reservations.");
      }
      const snapshot: Snapshot = {
        inputRate: model.inputPriceMicrosPerMillion, outputRate: model.outputPriceMicrosPerMillion,
        contextWindowTokens: model.contextWindowTokens, maxCompletionTokens: input.max_completion_tokens,
        inputBoundTokens: bound, deploymentName: model.deploymentName, modelVersion: model.modelVersion,
      };
      const id = randomUUID();
      await tx.query("UPDATE team_months SET reserved=reserved+$3 WHERE team_id=$1 AND period=$2", [teamId, period, reserved.toString()]);
      const [row] = await tx.query<Reservation>(
        `INSERT INTO reservations(id,team_id,period,model_id,actor,actor_type,client_app_id,snapshot,reserved,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved') RETURNING *`,
        [id, teamId, period, model.id, caller.id, caller.type, caller.type === "app" ? caller.clientAppId : null,
          JSON.stringify(snapshot), reserved.toString()]);
      const client = caller.type === "app" ? `;clientAppId=${caller.clientAppId}` : "";
      await audit(tx, caller.id, "inference.reserve", id, "success",
        `team=${teamId};model=${model.id};period=${period};reservedMicros=${reserved};callerType=${caller.type}${client}`, caller.type);
      return row!;
    });
  }

  async held(id: string): Promise<void> {
    await this.db.transaction(async tx => {
      const changed = await tx.query<{ actor: string; actor_type: "user" | "app" }>(
        "UPDATE reservations SET status='held' WHERE id=$1 AND status='reserved' RETURNING actor,actor_type", [id]);
      if (changed[0]) await audit(tx, changed[0].actor, "inference.held", id, "uncertain", "No automatic release or inference retry.", changed[0].actor_type);
    });
  }

  async settle(id: string, usage: unknown): Promise<{ chargedMicros: number; promptTokens: number; completionTokens: number }> {
    const [initial] = await this.db.query<Reservation>("SELECT * FROM reservations WHERE id=$1", [id]);
    if (!initial) return fail(404, "RESERVATION_NOT_FOUND", "Reservation not found.");
    const result = await this.db.transaction(async tx => {
      const [modelRow] = await tx.query<{ config: Model }>("SELECT config FROM models WHERE id=$1 FOR UPDATE", [initial.model_id]);
      await tx.query("SELECT id FROM teams WHERE id=$1 FOR UPDATE", [initial.team_id]);
      await tx.query<MonthRow>("SELECT * FROM team_months WHERE team_id=$1 AND period=$2 FOR UPDATE", [initial.team_id, initial.period]);
      const [row] = await tx.query<Reservation>("SELECT * FROM reservations WHERE id=$1 FOR UPDATE", [id]);
      if (!row) return fail(404, "RESERVATION_NOT_FOUND", "Reservation not found.");
      if (row.status === "settled") return {
        chargedMicros: safeNumber(row.charged!), promptTokens: safeNumber(row.prompt_tokens!), completionTokens: safeNumber(row.completion_tokens!),
      };
      if (row.status === "invalid_usage") return null;
      const v = usage as Partial<Usage> | null;
      const valid = v && [v.prompt_tokens, v.completion_tokens, v.total_tokens].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0);
      const s = row.snapshot;
      let charged = 0n;
      if (valid) charged = ceilCharge(v.prompt_tokens!, s.inputRate) + ceilCharge(v.completion_tokens!, s.outputRate);
      if (!valid || v!.prompt_tokens === 0 || v!.total_tokens !== v!.prompt_tokens! + v!.completion_tokens! ||
          v!.prompt_tokens! > s.inputBoundTokens || v!.prompt_tokens! > s.contextWindowTokens ||
          v!.completion_tokens! > s.maxCompletionTokens || charged > BigInt(row.reserved)) {
        await tx.query("UPDATE reservations SET status='invalid_usage' WHERE id=$1", [id]);
        if (modelRow) {
          const model = { ...modelRow.config, enabled: false, quarantined: true, status: "quarantined" };
          await tx.query("UPDATE models SET config=$2 WHERE id=$1", [row.model_id, JSON.stringify(model)]);
        }
        await audit(tx, row.actor, "inference.quarantine", id, "invalid_usage", "Reservation retained in full; model disabled. Operator reconciliation required.", row.actor_type);
        return null;
      }
      await tx.query(
        "UPDATE team_months SET reserved=reserved-$3,spent=spent+$4 WHERE team_id=$1 AND period=$2",
        [row.team_id, row.period, row.reserved, charged.toString()]);
      await tx.query(
        "UPDATE reservations SET status='settled',charged=$2,prompt_tokens=$3,completion_tokens=$4 WHERE id=$1",
        [id, charged.toString(), v!.prompt_tokens, v!.completion_tokens]);
      await audit(tx, row.actor, "inference.settle", id, "success", `chargedMicros=${charged}`, row.actor_type);
      return { chargedMicros: safeNumber(charged), promptTokens: v!.prompt_tokens!, completionTokens: v!.completion_tokens! };
    });
    if (!result) return fail(502, "INVALID_USAGE_RESERVATION_HELD", `Provider usage was invalid. Reservation ${id} remains held; model quarantined.`);
    return result;
  }
}
