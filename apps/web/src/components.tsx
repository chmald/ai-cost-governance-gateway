import { Component, useEffect, useState, type ReactNode } from "react";
import { errorMessage } from "./api";

export class PortalBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <main className="welcome"><div className="welcome-card"><h1>Unable to display gateway data</h1><div className="notice notice-error" role="alert"><p>The response could not be displayed safely. Reload to reconnect. No request will be replayed; check usage before sending inference again.</p></div><button className="button secondary" onClick={() => window.location.reload()}>Reload portal</button></div></main>
      : this.props.children;
  }
}

export function useResource<T>(load: () => Promise<T>) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    void load().then(
      (data) => { if (active) setState({ data, loading: false }); },
      (error: unknown) => { if (active) setState({ error, loading: false }); },
    );
    return () => { active = false; };
  }, [load, revision]);
  return { ...state, refresh: () => setRevision((value) => value + 1) };
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <strong>Action needed</strong>
      <p>{errorMessage(error)}</p>
      {onRetry && <button className="button secondary small" onClick={onRetry}>Try loading again</button>}
    </div>
  );
}

export function Loading({ label = "Loading gateway data…" }: { label?: string }) {
  return <div className="loading" role="status"><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><span className="empty-icon" aria-hidden="true">◇</span><h3>{title}</h3><p>{children}</p></div>;
}

export function PageHeading({ eyebrow, title, description, actions }: {
  eyebrow: string; title: string; description: string; actions?: ReactNode;
}) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{description}</p></div><div className="page-actions">{actions}</div></div>;
}

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warning" }) {
  return <span className={`badge badge-${tone}`}><span className="status-dot" aria-hidden="true" />{children}</span>;
}

export function ReadOnly({ admin }: { admin: boolean }) {
  return admin ? null : <p className="read-only">Read-only access. A Gateway.Admin can change this configuration.</p>;
}

export function Field({ label, hint, children, wide = false }: {
  label: string; hint?: string; children: ReactNode; wide?: boolean;
}) {
  return <label className={`field${wide ? " field-wide" : ""}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}

export function SaveNotice({ message }: { message: string }) {
  return message ? <div className="notice notice-success" role="status">{message}</div> : null;
}

export function FormActions({ pending, onCancel, submitLabel }: {
  pending: boolean; onCancel: () => void; submitLabel: string;
}) {
  return <div className="form-actions"><button className="button secondary" type="button" onClick={onCancel} disabled={pending}>Cancel</button><button className="button primary" type="submit" disabled={pending}>{pending ? "Submitting…" : submitLabel}</button></div>;
}

export function required(data: FormData, key: string, label: string): string {
  const value = String(data.get(key) ?? "").trim();
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

export function identifier(data: FormData, key: string, label: string): string {
  const value = required(data, key, label);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`${label} must be 1–64 letters, numbers, dots, hyphens, or underscores, starting with a letter or number.`);
  }
  return value;
}
