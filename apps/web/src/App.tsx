import { useEffect, useState, type ReactNode } from "react";
import { ApiError, createApi, type GatewayApi } from "./api";
import { createAuth, type AuthClient } from "./auth";
import { ErrorNotice, Loading } from "./components";
import { ActivityPage } from "./pages/Activity";
import { McpPage } from "./pages/Mcp";
import { ModelsPage } from "./pages/Models";
import { OverviewPage } from "./pages/Overview";
import { PlaygroundPage } from "./pages/Playground";
import { TeamsPage } from "./pages/Teams";
import type { PublicConfig, Session } from "./types";

type Connection = { config: PublicConfig; api: GatewayApi; auth?: AuthClient };
type Page = "overview" | "teams" | "models" | "mcp" | "activity" | "playground";

function validateSession(value: Session, config: PublicConfig): Session {
  if (!value?.user || typeof value.user.id !== "string" || typeof value.user.name !== "string" ||
      !Array.isArray(value.user.roles) || !value.user.roles.every((role) => typeof role === "string") ||
      value.mode !== config.mode) {
    throw new ApiError(200, "INVALID_SESSION", "The gateway returned an invalid or mismatched session. No demo fallback is allowed.");
  }
  return value;
}

export function App() {
  const [connection, setConnection] = useState<Connection>();
  const [session, setSession] = useState<Session>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    setConnection(undefined);
    setSession(undefined);
    void (async () => {
      const config = await createApi().config();
      const auth = config.mode === "azure" ? await createAuth(config) : undefined;
      const api = createApi(auth?.getToken);
      const nextSession = config.mode === "demo" ? validateSession(await api.session(), config) : undefined;
      if (active) {
        setConnection({ config, auth, api });
        setSession(nextSession);
      }
    })().catch((cause: unknown) => { if (active) setError(cause); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);

  async function signIn() {
    if (!connection?.auth || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await connection.auth.signIn();
      const next = validateSession(await connection.api.session(), connection.config);
      setSession(next);
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  async function signOut() {
    if (!connection?.auth || busy) return;
    setBusy(true);
    setError(undefined);
    setSession(undefined);
    try { await connection.auth.signOut(); }
    catch { setError(new Error("The portal is disconnected, but Microsoft sign-out could not be confirmed. Close this tab or try signing out again.")); }
    finally { setBusy(false); }
  }

  if (loading) return <Welcome><Loading label="Connecting to your gateway…" /></Welcome>;
  if (!connection) return <Welcome><h1>Gateway unavailable</h1><p className="muted">The portal could not load its configuration. It will not assume demo mode or invent data.</p><ErrorNotice error={error} onRetry={() => setRevision((value) => value + 1)} /></Welcome>;
  if (!session) return <Welcome>
    <p className="eyebrow">YOUR ORGANIZATION’S AI WORKSPACE</p><h1>Access with intention.</h1>
    <p className="muted">Sign in with your work account to access governed models, team budgets, and approved tools.</p>
    <div className="signin-note"><span className="status-dot" aria-hidden="true" />Single-tenant Microsoft Entra authentication</div>
    {error !== undefined && <ErrorNotice error={error} />}
    <button className="button primary full-width" disabled={busy} onClick={() => { void signIn(); }}>{busy ? "Connecting…" : "Sign in with Microsoft"}</button>
    <p className="footnote">No pasted access tokens. Sign-in opens only when requested. Access is validated by the gateway.</p>
  </Welcome>;
  return <Workspace api={connection.api} config={connection.config} session={session}
    authActions={connection.auth ? <><button className="text-button" disabled={busy} onClick={() => { void signIn(); }}>Reconnect</button><button className="button secondary small" disabled={busy} onClick={() => { void signOut(); }}>Sign out</button></> : null}
    authError={error} />;
}

function Welcome({ children }: { children: ReactNode }) {
  return <main className="welcome"><div className="welcome-card"><Brand /><div className="welcome-content">{children}</div><div className="welcome-footer">Purposeful access. Accountable usage.</div></div></main>;
}

function Brand() {
  return <div className="brand"><svg viewBox="0 0 32 32" width="32" height="32" fill="none" aria-hidden="true"><rect x="2" y="2" width="12" height="28" rx="3" fill="currentColor" /><path d="M19 2h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-8V2Zm0 16h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-8V18Z" fill="currentColor" opacity=".6" /></svg><span>AI Gateway<small>Governance workspace</small></span></div>;
}

export function Workspace({ api, config, session, authActions, authError }: {
  api: GatewayApi; config: PublicConfig; session: Session; authActions?: ReactNode; authError?: unknown;
}) {
  const admin = session.user.roles.includes("Gateway.Admin");
  const canRead = admin || session.user.roles.includes("Gateway.Reader");
  const canChat = admin || session.user.roles.includes("Gateway.User");
  const [page, setPage] = useState<Page>(canRead ? "overview" : "playground");
  const [mobileMenu, setMobileMenu] = useState(false);
  const demo = config.mode === "demo";
  const navigation: { page: Page; label: string; icon: string; available: boolean }[] = [
    { page: "overview", label: "Overview", icon: "◫", available: canRead },
    { page: "teams", label: "Teams & budgets", icon: "◎", available: canRead },
    { page: "models", label: "Models", icon: "▧", available: canRead },
    { page: "mcp", label: "MCP registry", icon: "⌘", available: canRead },
    { page: "activity", label: "Usage & audit", icon: "≋", available: canRead },
    { page: "playground", label: "Playground", icon: "▷", available: canChat || canRead },
  ];
  function navigate(next: Page) {
    setPage(next);
    setMobileMenu(false);
    document.getElementById("main-content")?.focus();
  }
  const allowedPage = page === "playground" ? canChat || canRead : canRead;
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className={`sidebar${mobileMenu ? " sidebar-open" : ""}`}><Brand /><div className="workspace-label"><span className="workspace-icon" aria-hidden="true">W</span><div>Internal workspace<small>Single tenant · USD</small></div></div>
      <p className="nav-label">WORKSPACE</p>
      <nav id="workspace-navigation" aria-label="Primary navigation">{navigation.filter((item) => item.available).map((item) => <button key={item.page} onClick={() => navigate(item.page)} className={`nav-item${page === item.page ? " active" : ""}`} aria-current={page === item.page ? "page" : undefined}><span className="nav-icon" aria-hidden="true">{item.icon}</span>{item.label}{page === item.page && <span className="nav-active-dot" aria-hidden="true" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="policy-mark"><span aria-hidden="true">◇</span>Governed by default</div><p>Identity, policy, and budget checks stay on the server.</p><span className="sidebar-version">INITIAL RELEASE · TEXT ONLY</span></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="header-left"><button className="menu-button" aria-expanded={mobileMenu} aria-controls="workspace-navigation" aria-label="Toggle navigation" onClick={() => setMobileMenu((value) => !value)}>☰</button><span className="breadcrumb">Workspace <span aria-hidden="true">/</span> <strong>{navigation.find((item) => item.page === page)?.label}</strong></span></div><div className="header-right"><span className={`environment-chip${demo ? " environment-demo" : ""}`}><i aria-hidden="true" />{demo ? "Local demo" : "Azure connected"}</span><div className="user-info"><span className="avatar" aria-hidden="true">{session.user.name.slice(0, 1).toUpperCase()}</span><span>{session.user.name}<small>{admin ? "Administrator" : canRead && canChat ? "Reader · User" : canRead ? "Reader" : canChat ? "User" : "No assigned role"}</small></span></div>{authActions}</div></header>
      {demo && <div className="demo-banner" role="note"><span className="demo-label">DEMO MODE</span><span>Local, explicitly enabled simulation. No real inference, Azure deployments, or APIM changes.</span></div>}
      <main id="main-content" className="content" tabIndex={-1}>
        {authError !== undefined && <ErrorNotice error={authError} />}
        {!allowedPage ? <div className="notice notice-error" role="alert"><strong>No gateway role assigned.</strong><p>Ask an administrator to assign Gateway.Reader, Gateway.User, or Gateway.Admin. The backend remains the authority for access.</p></div> : <>
          {page === "overview" && <OverviewPage api={api} onTeams={() => navigate("teams")} />}
          {page === "teams" && <TeamsPage api={api} admin={admin} />}
          {page === "models" && <ModelsPage api={api} admin={admin} demo={demo} />}
          {page === "mcp" && <McpPage api={api} admin={admin} demo={demo} />}
          {page === "activity" && <ActivityPage api={api} />}
          {page === "playground" && <PlaygroundPage api={api} session={session} demo={demo} />}
        </>}
      </main><footer className="page-footer"><span>AI Gateway · Internal workspace</span><span>USD ledger · UTC monthly periods · Backend-enforced policy</span></footer>
    </div>
  </div>;
}
