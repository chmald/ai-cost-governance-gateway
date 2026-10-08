import { useState, type FormEvent } from "react";
import type { GatewayApi } from "../api";
import { Empty, ErrorNotice, Field, FormActions, Loading, PageHeading, ReadOnly, SaveNotice, StatusBadge, identifier, required, useResource } from "../components";
import type { McpInput } from "../types";

export function McpPage({ api, admin, demo }: { api: GatewayApi; admin: boolean; demo: boolean }) {
  const state = useResource(api.mcpServers);
  const [editing, setEditing] = useState(false);
  const [success, setSuccess] = useState("");
  return <>
    <PageHeading eyebrow="GOVERNANCE / MCP" title="MCP registry"
      description="Register approved external tool servers and discover read-only gateway information."
      actions={<><button className="button secondary" disabled={state.loading || editing} onClick={state.refresh}>Refresh status</button>{admin && <button className="button primary" disabled={editing || !state.data} onClick={() => { setEditing(true); setSuccess(""); }}>+ Register server</button>}</>} />
    <ReadOnly admin={admin} />
    <SaveNotice message={success} />
    {state.loading && <Loading />}
    {state.error !== undefined && <ErrorNotice error={state.error} onRetry={state.refresh} />}
    {state.data && <>
      {editing && admin && <McpForm api={api} demo={demo} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); setSuccess("Registration request accepted. Refresh status to check readiness."); state.refresh(); }} />}
      <div className="notice notice-warning"><strong>External tool costs are separate.</strong><p>Unknown external MCP provider charges are not covered by the model budget ledger. Each server has its own authentication and rate policies; this registry does not provide native per-tool authorization.</p></div>
      {state.data.length === 0 ? <Empty title="No external servers registered">An administrator can register an HTTPS Streamable HTTP MCP server after its host and audience have been operator-allowlisted.</Empty> :
        <div className="card table-container"><table><caption className="sr-only">Registered external MCP servers</caption><thead><tr><th scope="col">Server</th><th scope="col">Gateway path</th><th scope="col">Backend / audience</th><th scope="col">Status</th><th scope="col">Cost coverage</th></tr></thead><tbody>{state.data.map((server) =>
          <tr key={server.id}><th scope="row"><span className="cell-title">{server.name}</span><span className="cell-meta">{server.id}</span></th><td className="mono break-word">{server.path}</td><td className="break-word"><span>{server.backendUrl}</span><span className="cell-meta">Audience: {server.authAudience}</span></td><td><StatusBadge>{server.status}</StatusBadge></td><td><span className="badge badge-warning">Not in model ledger</span></td></tr>
        )}</tbody></table></div>}
    </>}
    <section className="card tools-card" aria-labelledby="tools-title"><p className="eyebrow">GATEWAY INFORMATION TOOLS</p><h2 id="tools-title">Read-only by design</h2><p className="muted">APIM exports these REST operations as a separate MCP API. Call through the configured APIM gateway with end-user authentication; APIM supplies its managed-identity proof. Direct production API calls are rejected.</p>
      <div className="endpoint"><span className="method">GET</span><code>/mcp-tools/models</code><p>Enabled models visible to the authenticated principal.</p></div>
      <div className="endpoint"><span className="method">GET</span><code>/mcp-tools/budget</code><p>Current budgets for the authenticated principal’s teams.</p></div>
      <p className="footnote">These endpoints expose information only. They do not execute tools, change budgets, or return credentials.</p>
    </section>
  </>;
}

export function McpForm({ api, demo, onCancel, onSaved }: {
  api: GatewayApi; demo: boolean; onCancel: () => void; onSaved: () => void;
}) {
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(undefined);
    try {
      const backendUrl = required(data, "backendUrl", "Backend URL");
      let url: URL;
      try { url = new URL(backendUrl); } catch { throw new Error("Enter a valid HTTPS backend URL."); }
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
        throw new Error("Backend URL must use HTTPS, without credentials, query parameters, or a fragment. Do not enter tokens or keys.");
      }
      const input: McpInput = {
        id: identifier(data, "id", "Server ID"), name: required(data, "name", "Server name"),
        path: required(data, "path", "Gateway path"), backendUrl,
        authAudience: required(data, "authAudience", "Authentication audience"),
      };
      if (!/^\/?[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(input.path) || input.path.includes("//")) {
        throw new Error("Gateway path must contain only letters, numbers, slashes, underscores, and hyphens.");
      }
      setPending(true);
      await api.createMcp(input);
      onSaved();
    } catch (cause) { setError(cause); }
    finally { setPending(false); }
  }
  return <section className="card editor" aria-labelledby="mcp-form-title"><h2 id="mcp-form-title">Register an MCP server</h2>
    <p className="muted">{demo ? "Demo mode: saves a local registry record only. No APIM or provider change is made." : "The gateway checks operator host and audience allowlists before registering the server with APIM."}</p>
    <form onSubmit={submit} noValidate>{error !== undefined && <ErrorNotice error={error} />}
      <fieldset disabled={pending}><legend className="sr-only">MCP registration</legend><div className="form-grid">
        <Field label="Server ID"><input name="id" required maxLength={64} /></Field>
        <Field label="Server name"><input name="name" required maxLength={120} /></Field>
        <Field label="Gateway path" hint="APIM API path, e.g. mcp/knowledge."><input name="path" required placeholder="mcp/knowledge" /></Field>
        <Field label="Backend URL" hint="HTTPS Streamable HTTP endpoint. Never include credentials or tokens."><input name="backendUrl" type="url" required placeholder="https://tools.example.com/mcp" autoComplete="off" /></Field>
        <Field label="Authentication audience" wide hint="Operator-approved resource audience, not an access token or a secret."><input name="authAudience" required autoComplete="off" /></Field>
      </div></fieldset>
      <FormActions pending={pending} onCancel={onCancel} submitLabel={demo ? "Register demo server" : "Request registration"} />
    </form></section>;
}
