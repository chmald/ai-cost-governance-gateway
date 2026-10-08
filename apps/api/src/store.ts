import { randomUUID } from "node:crypto";
import type { Database, Sql } from "./db.js";
import { fail, safeNumber } from "./errors.js";
import { DEMO_AGENT_PRINCIPAL_ID, DEMO_PRINCIPAL_ID, modelCreate, modelFields, mcpCreate, identifier, principalId, teamCreate, supportedDeployment, type Caller, type DeploymentInventory, type Model, type ModelInput, type ModelUpdate, type Team, type TeamInput, type McpInput, type McpServer } from "./schemas.js";

export const month = (date = new Date()): string => date.toISOString().slice(0, 7);
export type MonthRow = { team_id: string; period: string; budget: string; spent: string; reserved: string };
export type TeamView = Omit<Team, "applications"> & { applications: string[]; period: string; spentMicros: number; reservedMicros: number };
export type ActorType = "user" | "app" | "system";

export const asCaller = (member: string | Caller): Caller => typeof member === "string" ? { id: member, type: "user" } : member;
export const isTeamMember = (team: Team, caller: Caller): boolean =>
  (caller.type === "app" ? team.applications ?? [] : team.principals).includes(caller.id);

export async function audit(tx: Sql, actor: string, action: string, target: string, outcome = "success", detail = "", actorType?: ActorType) {
  const type = actorType ?? (principalId.safeParse(actor).success ? "user" : "system");
  await tx.query("INSERT INTO audit(id,actor,action,target,outcome,detail,actor_type) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [randomUUID(), actor, action, target, outcome, detail, type]);
}

export async function ensureMonth(tx: Sql, team: Team, period: string): Promise<MonthRow> {
  await tx.query("INSERT INTO team_months(team_id,period,budget) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [team.id, period, team.monthlyBudgetMicros]);
  const [row] = await tx.query<MonthRow>("SELECT * FROM team_months WHERE team_id=$1 AND period=$2 FOR UPDATE", [team.id, period]);
  if (!row) return fail(503, "STORAGE_UNAVAILABLE", "Monthly ledger could not be locked.");
  return row;
}

export class Store {
  constructor(public db: Database, public now: () => Date = () => new Date()) {}

  async models(): Promise<Model[]> {
    return (await this.db.query<{ config: Model }>("SELECT config FROM models ORDER BY id LIMIT 1000")).map(r => r.config);
  }

  async teams(member?: string | Caller): Promise<TeamView[]> {
    const period = month(this.now());
    const caller = member === undefined ? undefined : asCaller(member);
    const rows = await this.db.query<{ config: Team; spent: string | null; reserved: string | null }>(
      `SELECT t.config,m.spent,m.reserved FROM teams t LEFT JOIN team_months m ON m.team_id=t.id AND m.period=$1
       ORDER BY t.id LIMIT 1000`, [period]);
    return rows.filter(r => !caller || isTeamMember(r.config, caller)).map(r => ({
      ...r.config, applications: r.config.applications ?? [], period,
      spentMicros: safeNumber(r.spent || 0), reservedMicros: safeNumber(r.reserved || 0),
    }));
  }

  async saveTeam(input: TeamInput, actor: string, update = false): Promise<TeamView> {
    input = teamCreate.parse(input);
    await this.db.transaction(async tx => {
      const [existing] = await tx.query<{ config: Team }>("SELECT config FROM teams WHERE id=$1 FOR UPDATE", [input.id]);
      if (update && !existing) fail(404, "TEAM_NOT_FOUND", "Team not found.");
      if (!update && existing) fail(409, "ALREADY_EXISTS", "Team already exists.");
      // Omitted applications on update preserve existing registrations (older clients never erase them).
      input = { ...input, applications: input.applications ?? existing?.config.applications ?? [] };
      if (input.applications!.some(id => input.principals.includes(id))) {
        fail(400, "PRINCIPAL_CONFLICT", "An object ID cannot be both a user member and an application identity.");
      }
      for (const id of input.allowedModels) {
        const found = await tx.query("SELECT id FROM models WHERE id=$1", [id]);
        if (!found.length) fail(400, "UNKNOWN_MODEL", "Allowed model IDs must exist.");
      }
      if (existing) {
        const period = month(this.now());
        const current = await ensureMonth(tx, existing.config, period);
        if (BigInt(input.monthlyBudgetMicros) < BigInt(current.spent) + BigInt(current.reserved)) {
          fail(409, "BUDGET_COMMITTED", "Budget cannot be less than current-month spent plus reserved funds.");
        }
        await tx.query("UPDATE teams SET config=$2 WHERE id=$1", [input.id, JSON.stringify(input)]);
        await tx.query("UPDATE team_months SET budget=$3 WHERE team_id=$1 AND period=$2", [input.id, period, input.monthlyBudgetMicros]);
      } else {
        await tx.query("INSERT INTO teams(id,config) VALUES ($1,$2)", [input.id, JSON.stringify(input)]);
        await ensureMonth(tx, input, month(this.now()));
      }
      await audit(tx, actor, update ? "team.update" : "team.create", input.id, "success",
        `members=${input.principals.length};applications=${input.applications!.length}`);
    });
    return (await this.teams()).find(t => t.id === input.id)!;
  }

  async createModel(input: ModelInput, actor: string, status: string): Promise<Model> {
    input = modelCreate.parse(input);
    this.validatePricing(input);
    const model: Model = { ...input, format: "OpenAI", status };
    await this.db.transaction(async tx => {
      await tx.query("INSERT INTO models(id,deployment_name,config) VALUES ($1,$2,$3)",
        [model.id, model.deploymentName, JSON.stringify(model)]);
      await audit(tx, actor, "model.create", model.id, "accepted");
    });
    return model;
  }

  private validatePricing(input: ModelUpdate) {
    if (Date.parse(input.pricingValidUntil) <= this.now().getTime()) fail(400, "STALE_PRICING", "Pricing validity must be in the future.");
    if (input.maxOutputTokens > input.contextWindowTokens) fail(400, "INVALID_MODEL_LIMITS", "Output limit cannot exceed the verified context window.");
  }

  async updateModel(id: string, fields: ModelUpdate, actor: string): Promise<Model> {
    identifier.parse(id);
    fields = modelFields.parse(fields);
    this.validatePricing(fields);
    return this.db.transaction(async tx => {
      const [row] = await tx.query<{ config: Model }>("SELECT config FROM models WHERE id=$1 FOR UPDATE", [id]);
      if (!row) return fail(404, "MODEL_NOT_FOUND", "Model not found.");
      if (fields.enabled && row.config.quarantined) fail(409, "MODEL_QUARANTINED", "Model needs evidence-based operator reconciliation; enabling is blocked.");
      if (fields.enabled && !supportedDeployment(row.config)) fail(409, "UNSUPPORTED_DEPLOYMENT", "Only on-demand OpenAI deployments can use the token-price budget ledger.");
      if (fields.enabled && !["Succeeded", "demo"].includes(row.config.status)) fail(409, "MODEL_NOT_READY", "Deployment is not ready.");
      const model = { ...row.config, ...fields };
      await tx.query("UPDATE models SET config=$2 WHERE id=$1", [id, JSON.stringify(model)]);
      await audit(tx, actor, "model.update", id);
      return model;
    });
  }

  async modelStatus(id: string, status: string, actor: string): Promise<void> {
    await this.db.transaction(async tx => {
      const [row] = await tx.query<{ config: Model }>("SELECT config FROM models WHERE id=$1 FOR UPDATE", [id]);
      if (!row) fail(404, "MODEL_NOT_FOUND", "Model not found.");
      const model = { ...row.config, status };
      await tx.query("UPDATE models SET config=$2 WHERE id=$1", [id, JSON.stringify(model)]);
      await audit(tx, actor, "model.provision", id, status);
    });
  }

  async importDeployment(deployment: DeploymentInventory): Promise<void> {
    await this.db.transaction(async tx => {
      const [row] = await tx.query<{ id: string; config: Model }>("SELECT id,config FROM models WHERE deployment_name=$1 FOR UPDATE", [deployment.name]);
      if (row) {
        const changed = row.config.modelName !== deployment.modelName || row.config.modelVersion !== deployment.modelVersion ||
          row.config.sku !== deployment.sku || (row.config.format ?? "OpenAI") !== deployment.format;
        const model: Model = { ...row.config, status: row.config.quarantined ? "quarantined" : deployment.status, modelName: deployment.modelName,
          modelVersion: deployment.modelVersion, sku: deployment.sku, capacity: deployment.capacity, format: deployment.format };
        if (changed) {
          model.enabled = false;
          model.inputPriceMicrosPerMillion = 0;
          model.outputPriceMicrosPerMillion = 0;
          model.contextWindowTokens = 0;
          model.maxOutputTokens = 0;
          model.pricingValidUntil = "1970-01-01T00:00:00.000Z";
          await audit(tx, "system", "model.inventory_drift", row.id, "requires_review", "Deployment identity or billing SKU changed; prior pricing invalidated.");
        }
        if (!supportedDeployment(model)) model.enabled = false;
        await tx.query("UPDATE models SET config=$2 WHERE id=$1", [row.id, JSON.stringify(model)]);
      } else {
        const model: Model = {
          id: deployment.name, displayName: `${deployment.name} (unpriced)`, deploymentName: deployment.name,
          modelName: deployment.modelName, modelVersion: deployment.modelVersion,
          sku: deployment.sku, capacity: deployment.capacity, format: deployment.format,
          inputPriceMicrosPerMillion: 0, outputPriceMicrosPerMillion: 0, contextWindowTokens: 0, maxOutputTokens: 0,
          pricingValidUntil: "1970-01-01T00:00:00.000Z", enabled: false, status: deployment.status,
        };
        const inserted = await tx.query("INSERT INTO models(id,deployment_name,config) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
          [model.id, model.deploymentName, JSON.stringify(model)]);
        if (!inserted.length) fail(409, "INVENTORY_ID_COLLISION", "A discovered deployment conflicts with an existing gateway model ID.");
      }
    });
  }

  async mcpServers(): Promise<McpServer[]> {
    return (await this.db.query<{ config: McpServer }>("SELECT config FROM mcp_servers ORDER BY id LIMIT 1000")).map(r => r.config);
  }

  async createMcp(input: McpInput, actor: string, status: string): Promise<McpServer> {
    input = mcpCreate.parse(input);
    const server: McpServer = { ...input, status, toolCostsCovered: false };
    await this.db.transaction(async tx => {
      await tx.query("INSERT INTO mcp_servers(id,path,config) VALUES ($1,$2,$3)", [input.id, input.path, JSON.stringify(server)]);
      await audit(tx, actor, "mcp.create", input.id, "accepted", "External tool costs are not covered.");
    });
    return server;
  }

  async mcpStatus(id: string, status: string, actor: string) {
    await this.db.transaction(async tx => {
      await tx.query("UPDATE mcp_servers SET config=jsonb_set(config,'{status}',to_jsonb($2::text)) WHERE id=$1", [id, status]);
      await audit(tx, actor, "mcp.provision", id, status);
    });
  }

  async usage() {
    const rows = await this.db.query<{
      id: string; created_at: Date | string; team_id: string; model_id: string; reserved: string;
      charged: string | null; status: string; prompt_tokens: string | null; completion_tokens: string | null;
      actor: string; actor_type: "user" | "app"; client_app_id: string | null;
    }>(`SELECT id,created_at,team_id,model_id,reserved,charged,status,prompt_tokens,completion_tokens,actor,actor_type,client_app_id
        FROM reservations ORDER BY created_at DESC LIMIT 200`);
    return rows.map(r => ({
      id: r.id, createdAt: new Date(r.created_at).toISOString(), teamId: r.team_id, modelId: r.model_id,
      reservedMicros: safeNumber(r.reserved), chargedMicros: safeNumber(r.charged || 0), status: r.status,
      actorId: r.actor, actorType: r.actor_type, ...(r.client_app_id ? { clientAppId: r.client_app_id } : {}),
      ...(r.prompt_tokens !== null ? { promptTokens: safeNumber(r.prompt_tokens), completionTokens: safeNumber(r.completion_tokens!) } : {}),
    }));
  }

  async audits() {
    return this.db.query(`SELECT id,timestamp,actor,COALESCE(actor_type,'unknown') AS "actorType",action,target,outcome,detail
      FROM audit ORDER BY timestamp DESC LIMIT 200`);
  }
}

export async function seedDemo(db: Database): Promise<void> {
  await db.transaction(async tx => {
    const model: Model = {
      id: "demo-chat", displayName: "Simulated chat (FAKE — no Azure)", deploymentName: "demo-chat",
      modelName: "fake-text-model", modelVersion: "demo-1", sku: "Standard", capacity: 1,
      inputPriceMicrosPerMillion: 150_000, outputPriceMicrosPerMillion: 600_000,
      contextWindowTokens: 8192, maxOutputTokens: 2048,
      pricingValidUntil: "2099-01-01T00:00:00.000Z", enabled: true, status: "demo",
    };
    await tx.query("INSERT INTO models(id,deployment_name,config) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [model.id, model.deploymentName, JSON.stringify(model)]);
    for (const [id, name, budget, applications] of [
      ["demo-engineering", "Demo Engineering (FAKE)", 25_000_000, [DEMO_AGENT_PRINCIPAL_ID]],
      ["demo-research", "Demo Research (FAKE)", 10_000_000, []],
    ] as const) {
      const team: Team = { id, name, monthlyBudgetMicros: budget, allowedModels: [model.id], principals: [DEMO_PRINCIPAL_ID], applications: [...applications] };
      const added = await tx.query("INSERT INTO teams(id,config) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id", [id, JSON.stringify(team)]);
      if (added.length) await audit(tx, "demo-seed", "team.create", id, "success", "Clearly fake local-only demonstration data.");
    }
  });
}
