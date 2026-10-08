import { useState } from "react";
import type { GatewayApi } from "../api";
import { Empty, ErrorNotice, Loading, PageHeading, StatusBadge, useResource } from "../components";
import { formatUsd, utcTime } from "../money";

export function ActivityPage({ api }: { api: GatewayApi }) {
  const [tab, setTab] = useState<"usage" | "audit">("usage");
  return <>
    <PageHeading eyebrow="OBSERVABILITY / ACTIVITY" title="Usage & audit"
      description="Follow model reservations, settled charges, and administrative changes." />
    <div className="segmented" aria-label="Activity view"><button aria-pressed={tab === "usage"} onClick={() => setTab("usage")}>Model usage</button><button aria-pressed={tab === "audit"} onClick={() => setTab("audit")}>Audit trail</button></div>
    {tab === "usage" ? <UsageTable api={api} /> : <AuditTable api={api} />}
  </>;
}

function UsageTable({ api }: { api: GatewayApi }) {
  const state = useResource(api.usage);
  const [filter, setFilter] = useState("");
  const rows = state.data?.filter((row) => `${row.id} ${row.teamId} ${row.modelId} ${row.status} ${row.actorType ?? ""} ${row.actorId ?? ""} ${row.clientAppId ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  return <>
    <div className="table-toolbar"><label className="search-field"><span className="sr-only">Filter loaded usage rows</span><input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter team, model, caller, or status…" /></label><button className="button secondary" onClick={state.refresh} disabled={state.loading}>Refresh usage</button></div>
    <p className="footnote">USD at configured prices, not Azure billed cost. Reserved amounts are request records, not a sum of currently held funds; see the overview for the current balance. No automatic retries or reservation release on uncertain outcomes.</p>
    {state.loading && <Loading />}
    {state.error !== undefined && <ErrorNotice error={state.error} onRetry={state.refresh} />}
    {rows && (rows.length === 0 ? <Empty title={filter ? "No matching usage" : "No model usage yet"}>{filter ? "Try a different filter of the loaded records." : "Requests will appear here with their reservation, outcome, and settled charge."}</Empty> :
      <div className="card table-container"><table><caption className="sr-only">Model usage ledger in USD, timestamps in UTC</caption>      <thead><tr><th scope="col">Request / UTC time</th><th scope="col">Team / model</th><th scope="col">Caller</th><th scope="col">Status</th><th scope="col">Reserved</th><th scope="col">Settled</th><th scope="col">Input / output tokens</th></tr></thead><tbody>{rows.map((row) =>
              <tr key={row.id}><th scope="row"><span className="mono cell-title">{row.id}</span><span className="cell-meta">{utcTime(row.createdAt)}</span></th><td><span className="cell-title">{row.teamId}</span><span className="cell-meta">{row.modelId}</span></td><td><StatusBadge tone={row.actorType === "app" ? "good" : "neutral"}>{row.actorType === "app" ? "App" : "User"}</StatusBadge>{row.actorId && <span className="cell-meta mono break-word">{row.actorId}</span>}{row.clientAppId && <span className="cell-meta mono break-word">client {row.clientAppId}</span>}</td><td><StatusBadge tone={/uncertain|pending|reserved/i.test(row.status) ? "warning" : "neutral"}>{row.status}</StatusBadge></td><td className="money">{formatUsd(row.reservedMicros)}</td><td className="money">{formatUsd(row.chargedMicros)}</td><td className="money">{row.promptTokens?.toLocaleString("en-US") ?? "—"} / {row.completionTokens?.toLocaleString("en-US") ?? "—"}</td></tr>
      )}</tbody></table></div>)}
  </>;
}

function AuditTable({ api }: { api: GatewayApi }) {
  const state = useResource(api.audit);
  const [filter, setFilter] = useState("");
  const rows = state.data?.filter((row) => `${row.actor} ${row.actorType ?? ""} ${row.action} ${row.target} ${row.outcome}`.toLowerCase().includes(filter.toLowerCase()));
  return <>
    <div className="table-toolbar"><label className="search-field"><span className="sr-only">Filter loaded audit rows</span><input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter actor, action, or target…" /></label><button className="button secondary" onClick={state.refresh} disabled={state.loading}>Refresh audit</button></div>
    <p className="footnote">Administrative metadata only. Audit records must not include prompts, completions, credentials, or access tokens. All timestamps are UTC.</p>
    {state.loading && <Loading />}
    {state.error !== undefined && <ErrorNotice error={state.error} onRetry={state.refresh} />}
    {rows && (rows.length === 0 ? <Empty title={filter ? "No matching events" : "No audit events yet"}>{filter ? "Try a different filter of the loaded records." : "Administrative changes and request outcomes will appear here."}</Empty> :
      <div className="card table-container"><table><caption className="sr-only">Administrative audit trail, timestamps in UTC</caption><thead><tr><th scope="col">Time / actor</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Outcome</th><th scope="col">Detail</th></tr></thead><tbody>{rows.map((row) =>
        <tr key={row.id}><th scope="row"><span className="cell-title">{utcTime(row.timestamp)}</span><span className="cell-meta mono">{row.actor}</span>{row.actorType && row.actorType !== "unknown" && <span className="cell-meta">{row.actorType === "app" ? "application" : row.actorType}</span>}</th><td>{row.action}</td><td className="mono break-word">{row.target}</td><td><StatusBadge>{row.outcome}</StatusBadge></td><td className="audit-detail">{typeof row.detail === "string" ? row.detail : "Structured metadata omitted."}</td></tr>
      )}</tbody></table></div>)}
  </>;
}
