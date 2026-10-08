import type { GatewayApi } from "../api";
import { Empty, ErrorNotice, Loading, PageHeading, useResource } from "../components";
import { formatUsd, utcMonth } from "../money";

export function OverviewPage({ api, onTeams }: { api: GatewayApi; onTeams: () => void }) {
  const state = useResource(api.overview);
  const data = state.data;
  const available = data ? data.budgetMicros - data.spentMicros - data.reservedMicros : 0;
  return <>
    <PageHeading eyebrow="WORKSPACE / OVERVIEW" title="Your AI, within bounds."
      description="One place to govern model access and configured team spending."
      actions={<button className="button secondary" onClick={state.refresh} disabled={state.loading}>Refresh</button>} />
    {state.loading && <Loading />}
    {state.error !== undefined && <ErrorNotice error={state.error} onRetry={state.refresh} />}
    {data && <>
      <div className="section-label"><h2>Budget at a glance</h2><span className="period">{utcMonth(data.period)}</span></div>
      <div className="metric-grid">
        <Metric label="Configured budget" value={formatUsd(data.budgetMicros)} note="Total monthly team allocation" />
        <Metric label="Settled spend" value={formatUsd(data.spentMicros)} note="Recorded usage × configured prices" />
        <Metric label="Reserved" value={formatUsd(data.reservedMicros)} note="In-flight and uncertain outcomes" />
        <Metric label="Available" value={formatUsd(available)} note="Budget less settled and reserved" accent />
      </div>
      <section className="card budget-card" aria-labelledby="admission-title">
        <div className="card-heading"><div><p className="eyebrow">CONFIGURED-PRICE ADMISSION</p><h2 id="admission-title">Make every request accountable.</h2></div><span className="badge badge-good">Reservations before inference</span></div>
        {data.budgetMicros > 0 && <>
          <div className="budget-track" role="img" aria-label={`Settled ${formatUsd(data.spentMicros)}, reserved ${formatUsd(data.reservedMicros)}, available ${formatUsd(available)}`}>
            <span className="budget-settled" style={{ width: `${Math.min(100, data.spentMicros / data.budgetMicros * 100)}%` }} />
            <span className="budget-reserved" style={{ width: `${Math.max(0, Math.min(100 - data.spentMicros / data.budgetMicros * 100, data.reservedMicros / data.budgetMicros * 100))}%` }} />
          </div>
          <div className="legend"><span><i className="legend-settled" />Settled</span><span><i className="legend-reserved" />Reserved</span><span><i className="legend-available" />Available</span></div>
        </>}
        <p>Each admitted request reserves a conservative maximum using configured deployment limits and prices. Uncertain requests keep their reservation until an explicit, auditable reconciliation.</p>
        <div className="notice notice-warning"><strong>Not an Azure invoice cap.</strong><p>This ledger limits admission at configured prices. Provisioned throughput, fixed hosting charges, bypass traffic, and external MCP provider charges are not covered. Administrators must verify on-demand deployment eligibility, rate cards, and token limits.</p></div>
      </section>
      <div className="resource-grid">
        <div className="card resource-card"><span className="resource-symbol" aria-hidden="true">◎</span><strong>{data.teams}</strong><span>Teams with budgets</span><button className="text-button" onClick={onTeams}>View team allocations →</button></div>
        <div className="card resource-card"><span className="resource-symbol" aria-hidden="true">▧</span><strong>{data.deployments}</strong><span>Model deployments</span><p className="muted">Access and pricing governed centrally</p></div>
        <div className="card resource-card"><span className="resource-symbol" aria-hidden="true">⌘</span><strong>{data.mcpServers}</strong><span>Registered MCP servers</span><p className="muted">Separate provider costs and policies</p></div>
      </div>
      {data.teams === 0 && <Empty title="A clean slate">Create a team, set its USD budget, and explicitly assign models and members to get started.</Empty>}
    </>}
  </>;
}

function Metric({ label, value, note, accent }: { label: string; value: string; note: string; accent?: boolean }) {
  return <div className={`card metric${accent ? " metric-accent" : ""}`}><p>{label}</p><strong>{value}</strong><span>{note}</span></div>;
}
