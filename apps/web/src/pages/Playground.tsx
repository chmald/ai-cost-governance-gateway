import { useCallback, useState, type FormEvent } from "react";
import type { GatewayApi } from "../api";
import { Empty, ErrorNotice, Field, Loading, PageHeading, StatusBadge, useResource } from "../components";
import { formatUsd, positiveInteger, utcMonth } from "../money";
import type { ChatResponse, Session } from "../types";

export function PlaygroundPage({ api, session, demo }: { api: GatewayApi; session: Session; demo: boolean }) {
  const canChat = session.user.roles.includes("Gateway.Admin") || session.user.roles.includes("Gateway.User");
  return <>
    <PageHeading eyebrow="WORKSPACE / PLAYGROUND" title="A governed place to try."
      description="A single, non-streaming text request through the gateway. Team policy applies to every call."
      actions={<StatusBadge tone={demo ? "warning" : "good"}>{demo ? "Simulated inference" : "Gateway inference"}</StatusBadge>} />
    {!canChat ? <div className="notice notice-info"><strong>Inference access required</strong><p>Your read-only role can inspect the workspace. A Gateway.User or Gateway.Admin role and explicit team membership are required to run a prompt.</p></div>
      : <PlaygroundForm api={api} session={session} demo={demo} />}
  </>;
}

function PlaygroundForm({ api, session, demo }: { api: GatewayApi; session: Session; demo: boolean }) {
  const load = useCallback(async () => {
    const [teams, models] = await Promise.all([api.teams(), api.models()]);
    return { teams, models };
  }, [api]);
  const state = useResource(load);
  const [teamId, setTeamId] = useState("");
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState("256");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<ChatResponse>();
  const [asAgent, setAsAgent] = useState(false);
  const agent = demo ? session.demoAgent : undefined;
  const callerId = (asAgent && agent ? agent.id : session.user.id).toLowerCase();
  const teams = state.data?.teams.filter((team) => (asAgent && agent ? team.applications ?? [] : team.principals)
    .some((id) => id.toLowerCase() === callerId)) ?? [];
  const team = teams.find((candidate) => candidate.id === teamId);
  const models = state.data?.models.filter((model) => team?.allowedModels.includes(model.id)) ?? [];
  const model = models.find((candidate) => candidate.id === modelId);
  const modelBlocked = !!model && (!model.enabled || !Number.isFinite(Date.parse(model.pricingValidUntil)) || Date.parse(model.pricingValidUntil) <= Date.now());
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(undefined);
    setResult(undefined);
    try {
      if (!team || !model) throw new Error("Select one of your teams and an allowed model.");
      if (modelBlocked) throw new Error("This model is disabled or has expired pricing. Ask an administrator to review it.");
      if (!prompt.trim()) throw new Error("Enter a text prompt.");
      const maxCompletionTokens = positiveInteger(maxTokens, "Maximum completion tokens");
      if (maxCompletionTokens > model.maxOutputTokens) throw new Error(`Maximum completion tokens cannot exceed this deployment's ${model.maxOutputTokens.toLocaleString("en-US")} token output limit.`);
      setPending(true);
      const response = await api.chat({
        teamId: team.id, modelId: model.id,
        messages: [{ role: "user", content: prompt }], maxCompletionTokens,
        ...(asAgent && agent ? { simulateAgent: true } : {}),
      });
      setResult(response);
    } catch (cause) { setError(cause); }
    finally { setPending(false); }
  }
  return <>
    <div className="playground-toolbar"><button className="button secondary small" type="button" onClick={state.refresh} disabled={pending || state.loading}>Refresh access & balances</button></div>
    <div className={`notice ${demo ? "notice-warning" : "notice-info"}`}><strong>{demo ? "Local demo: no real inference." : "Configured-budget admission is enforced."}</strong><p>{demo ? "Responses are simulated by the local API. No prompt is sent to Foundry and no cloud resource is changed." : "A conservative reservation can exceed the eventual charge. A timeout or uncertain response keeps the reservation; check usage before deciding to send a new request."}</p></div>
    {state.loading && <Loading label="Loading team access and model policies…" />}
    {state.error !== undefined && <ErrorNotice error={state.error} onRetry={state.refresh} />}
    {agent && <label className="check-row agent-toggle"><input type="checkbox" checked={asAgent} disabled={pending}
      onChange={(event) => { setAsAgent(event.target.checked); setTeamId(""); setModelId(""); setResult(undefined); setError(undefined); }} />
      <span>Call as the demo agent identity (app-only, FAKE)<small>Simulates a managed identity or service principal holding the Gateway.Agent app role. Charges go to teams where {agent.id} is a registered application identity.</small></span></label>}
    {state.data && (teams.length === 0 ? (asAgent ? <Empty title="No team registration">Register the demo agent's object ID as an application identity on a team to let it spend that team's budget.</Empty>
      : <Empty title="No team membership">Ask an administrator to add your Entra object ID to a team and allow a model. An Admin role does not bypass membership checks.</Empty>) :
      <div className="playground-grid">
        <section className="card prompt-card" aria-labelledby="request-title"><h2 id="request-title">Compose a request</h2><p className="muted">Text only. Tools, streaming, images, and audio are not supported.</p>
          <form onSubmit={submit} noValidate>
            <fieldset disabled={pending}><legend className="sr-only">Playground request</legend><div className="form-grid">
              <Field label="Team"><select value={teamId} required onChange={(event) => { setTeamId(event.target.value); setModelId(""); }}><option value="">Select your team</option>{teams.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
              <Field label="Model"><select value={modelId} required disabled={!team} onChange={(event) => setModelId(event.target.value)}><option value="">Select an allowed model</option>{models.map((item) => <option key={item.id} value={item.id} disabled={!item.enabled || Date.parse(item.pricingValidUntil) <= Date.now()}>{item.displayName}{!item.enabled ? " · disabled" : Date.parse(item.pricingValidUntil) <= Date.now() ? " · expired pricing" : ""}</option>)}</select></Field>
              <Field label="Maximum completion tokens" hint={model ? `Deployment limit: ${model.maxOutputTokens.toLocaleString("en-US")} tokens, including reasoning tokens. This is a limit, not guaranteed visible output.` : "A positive whole number including reasoning tokens, within the selected deployment's output limit."}><input value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} inputMode="numeric" required /></Field>
              <Field label="Prompt" wide hint="Do not submit credentials or secrets. This page does not persist your prompt. Each submission is a separate, single-turn request."><textarea rows={8} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="What would you like to explore?" required /></Field>
            </div></fieldset>
            {team && <div className="request-budget"><span>{utcMonth(team.period)}</span><strong>{formatUsd(team.monthlyBudgetMicros - team.spentMicros - team.reservedMicros)} available</strong><small>Snapshot only. The server atomically checks the budget at admission.</small></div>}
            {team && models.length === 0 && <p className="notice notice-info">This team has no allowed models. Ask an administrator to grant access.</p>}
            {error !== undefined && <ErrorNotice error={error} />}
            <div className="form-actions"><button className="button secondary" type="button" disabled={pending} onClick={() => { setPrompt(""); setResult(undefined); setError(undefined); }}>Clear</button><button className="button primary" type="submit" disabled={pending || !team || !model || modelBlocked}>{pending ? "Waiting for response…" : demo ? "Run demo request" : "Send request"}</button></div>
          </form>
        </section>
        <section className="card response-card" aria-labelledby="response-title"><div className="card-heading"><h2 id="response-title">Response</h2><span className="subtle-chip">Non-streaming</span></div>
          <div aria-live="polite" aria-busy={pending}>
            {pending ? <Loading label="Request in progress. Keep this page open; do not resubmit." /> : result ? <>
              <div className="response-content">{result.content}</div>
              <dl className="detail-list response-usage"><div><dt>Input tokens</dt><dd>{result.usage.promptTokens.toLocaleString("en-US")}</dd></div><div><dt>Output tokens</dt><dd>{result.usage.completionTokens.toLocaleString("en-US")}</dd></div><div><dt>{demo ? "Simulated charge" : "Settled charge"}</dt><dd>{formatUsd(result.usage.chargedMicros)}</dd></div><div><dt>Request</dt><dd className="mono">{result.id}</dd></div></dl>
            </> : <Empty title="Ready when you are">Choose a team and model, then send a text prompt. No request runs automatically.</Empty>}
          </div>
        </section>
      </div>)}
    <p className="footnote">Selections reflect session metadata for user experience only. The backend validates identity, membership, model readiness, pricing, and budget on every request. Requests are never automatically retried.</p>
  </>;
}
