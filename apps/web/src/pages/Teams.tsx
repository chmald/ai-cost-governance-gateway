import { useCallback, useState, type FormEvent } from "react";
import type { GatewayApi } from "../api";
import { Empty, ErrorNotice, Field, FormActions, Loading, PageHeading, ReadOnly, SaveNotice, identifier, required, useResource } from "../components";
import { formatUsd, parseUsd, usdInput, utcMonth } from "../money";
import type { Model, Team, TeamInput } from "../types";

export function TeamsPage({ api, admin }: { api: GatewayApi; admin: boolean }) {
  const load = useCallback(async () => {
    const [teams, models] = await Promise.all([api.teams(), api.models()]);
    return { teams, models };
  }, [api]);
  const state = useResource(load);
  const [editing, setEditing] = useState<Team | "new" | null>(null);
  const [success, setSuccess] = useState("");
  return <>
    <PageHeading eyebrow="GOVERNANCE / TEAMS" title="Teams & budgets"
      description="Explicit membership. Monthly USD allocations. Only the models each team needs."
      actions={<><button className="button secondary" onClick={state.refresh} disabled={state.loading || !!editing}>Refresh</button>{admin && <button className="button primary" onClick={() => { setEditing("new"); setSuccess(""); }} disabled={!!editing || !state.data}>+ Create team</button>}</>} />
    <ReadOnly admin={admin} />
    <SaveNotice message={success} />
    {state.loading && <Loading />}
    {state.error !== undefined && <ErrorNotice error={state.error} onRetry={state.refresh} />}
    {state.data && <>
      {editing && admin && <TeamForm key={editing === "new" ? "new" : editing.id}
        team={editing === "new" ? undefined : editing} models={state.data.models} api={api}
        onCancel={() => setEditing(null)} onSaved={() => { setSuccess("Team saved. Membership and budget are enforced by the gateway."); setEditing(null); state.refresh(); }} />}
      <div className="notice notice-info"><strong>Monthly ledger · UTC</strong><p>Available = configured budget − settled spend − reservations. A lower budget does not erase existing spend or reservations. This is not an Azure invoice cap.</p></div>
      {state.data.teams.length === 0 ? <Empty title="No teams yet">An administrator can create a team and assign a monthly budget, members, and allowed models.</Empty> :
        <div className="card table-container"><table><caption className="sr-only">Team monthly budgets and allowed models</caption><thead><tr><th scope="col">Team / UTC month</th><th scope="col">Budget</th><th scope="col">Settled</th><th scope="col">Reserved</th><th scope="col">Available</th><th scope="col">Access</th>{admin && <th scope="col">Actions</th>}</tr></thead>
          <tbody>{state.data.teams.map((team) => <tr key={team.id}><th scope="row"><span className="cell-title">{team.name}</span><span className="cell-meta">{team.id} · {utcMonth(team.period)}</span></th><td className="money">{formatUsd(team.monthlyBudgetMicros)}</td><td className="money">{formatUsd(team.spentMicros)}</td><td className="money">{formatUsd(team.reservedMicros)}</td><td className="money strong">{formatUsd(team.monthlyBudgetMicros - team.spentMicros - team.reservedMicros)}</td><td><span>{team.principals.length} member{team.principals.length === 1 ? "" : "s"}</span><span className="cell-meta">{(team.applications ?? []).length} app identit{(team.applications ?? []).length === 1 ? "y" : "ies"} · {team.allowedModels.length} allowed models</span></td>{admin && <td><button className="button secondary small" aria-label={`Edit ${team.name}`} disabled={!!editing} onClick={() => { setEditing(team); setSuccess(""); }}>Edit</button></td>}</tr>)}</tbody></table></div>}
      <p className="footnote">Team IDs are immutable. This API supports creating and updating teams, not deleting ledger history. Remove membership or model access to stop future requests.</p>
    </>}
  </>;
}

export function TeamForm({ team, models, api, onCancel, onSaved }: {
  team?: Team; models: Model[]; api: GatewayApi; onCancel: () => void; onSaved: () => void;
}) {
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const modelOptions = [...new Set([...models.map((model) => model.id), ...(team?.allowedModels ?? [])])];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(undefined);
    try {
      const guids = (field: string, label: string) => {
        const values = [...new Set(String(data.get(field) ?? "").split(/[\s,;]+/).filter(Boolean))];
        if (values.some((id) => !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
          throw new Error(`Each ${label} must be a valid Entra object ID (GUID), separated by commas or new lines.`);
        }
        return values;
      };
      const principals = guids("principals", "member");
      const applications = guids("applications", "application identity");
      if (applications.some((id) => principals.some((member) => member.toLowerCase() === id.toLowerCase()))) {
        throw new Error("An object ID cannot be both a user member and an application identity.");
      }
      const input: TeamInput = {
        id: team?.id ?? identifier(data, "id", "Team ID"),
        name: required(data, "name", "Team name"),
        monthlyBudgetMicros: parseUsd(required(data, "budget", "Monthly budget")),
        allowedModels: data.getAll("allowedModels").map(String),
        principals,
        applications,
      };
      setPending(true);
      if (team) {
        const { id, ...changes } = input;
        await api.updateTeam(id, changes);
      } else await api.createTeam(input);
      onSaved();
    } catch (cause) { setError(cause); }
    finally { setPending(false); }
  }
  return <section className="card editor" aria-labelledby="team-form-title"><h2 id="team-form-title">{team ? `Edit ${team.name}` : "Create a team"}</h2>
    <p className="muted">No implicit access. Members need an inference role and explicit team membership.</p>
    <form onSubmit={submit} noValidate>
      {error !== undefined && <ErrorNotice error={error} />}
      <fieldset disabled={pending}><legend className="sr-only">Team settings</legend><div className="form-grid">
        {!team && <Field label="Team ID" hint="Stable identifier, e.g. product-engineering."><input name="id" required maxLength={64} autoComplete="off" /></Field>}
        <Field label="Team name"><input name="name" required maxLength={120} defaultValue={team?.name} /></Field>
        <Field label="Monthly budget (USD)" hint="Exact amount; up to 6 decimal places. Zero admits no paid requests."><input name="budget" required inputMode="decimal" placeholder="250.00" defaultValue={team ? usdInput(team.monthlyBudgetMicros) : ""} /></Field>
        <Field label="Member object IDs" wide hint="Entra oid GUIDs, one per line or comma-separated. No names, emails, or tokens."><textarea name="principals" rows={3} defaultValue={team?.principals.join("\n")} spellCheck={false} /></Field>
        <Field label="Application identity object IDs" wide hint="Optional app-only callers (managed identities, service principals, agent identities): the service principal object ID (token oid), not the client ID. Each also needs the Gateway.Agent app role."><textarea name="applications" rows={2} defaultValue={team?.applications?.join("\n")} spellCheck={false} /></Field>
      </div><fieldset className="model-choices"><legend>Allowed models</legend>{modelOptions.length === 0 ? <p className="muted">No models are registered. You can save this team without model access.</p> : modelOptions.map((id) => {
        const model = models.find((candidate) => candidate.id === id);
        return <label className="check-row" key={id}><input type="checkbox" name="allowedModels" value={id} defaultChecked={team?.allowedModels.includes(id)} /><span>{model?.displayName ?? id}<small>{id}{model && !model.enabled ? " · disabled" : ""}{!model ? " · unavailable" : ""}</small></span></label>;
      })}</fieldset></fieldset>
      <FormActions pending={pending} onCancel={onCancel} submitLabel={team ? "Save changes" : "Create team"} />
    </form></section>;
}
