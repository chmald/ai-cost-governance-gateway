# Security boundaries and operations

## Identities

The portal uses a single-tenant Entra SPA registration and a delegated scope
for the governance API. The backend validates signature, issuer, audience,
expiry, tenant, and assigned application roles. Browser visibility checks are
only a UX convenience; the API is authoritative.

| Role | Intended capability |
| --- | --- |
| `Gateway.Reader` | Read governance configuration and reporting. |
| `Gateway.User` | Infer using explicitly assigned teams and models. |
| `Gateway.Admin` | Change configuration, create deployments, register approved MCP servers. |
| `Gateway.Agent` | **Application permission** (app-only callers only): infer and read the MCP catalog/budget for teams that register the caller. |

Inference additionally requires membership in the selected team. Do not assign
admin roles to ordinary inference clients.

Users present a **delegated access token** with the API scope (`scp`).
App-only tokens (managed identities, service principals, Entra agent
identities) are accepted only on the data plane (inference and read-only MCP
tools), only when they carry no `scp`, carry the `Gateway.Agent` app role
(which can be assigned only to applications), present a client application ID
(`azp`/`appid`), and are not APIM's own identity. The caller's service-principal
object ID (`oid`) must be registered in the selected team's `applications`
list, which is kept disjoint from user `principals`. App-only tokens are always
rejected on portal/admin routes, and `Gateway.Agent` is stripped from delegated
tokens. Reservations and audit rows record `actor_type` (`user`/`app`) and the
client application ID. The API app registration keeps
`appRoleAssignmentRequired`, so a tenant application cannot obtain a token for
it without an explicit assignment.

APIM authenticates the caller and forwards the original user access token.
It supplies its own managed-identity token in `X-Gateway-Authorization`.
The application checks this proof independently against the expected APIM
principal and audience before accepting data-plane requests. A caller's
arbitrary header cannot substitute for a valid gateway token.

The application uses managed identity for Azure operations. Production must
not depend on a developer's Azure CLI login, pasted bearer tokens, or model
API keys. Grants are scoped to the existing Foundry account and APIM service.

## Network and bypass controls

Protect the existing Foundry account independently. Remove unnecessary
inference RBAC assignments, disable local key authentication where supported,
and use private connectivity/firewall policies. The template does not silently
rewrite networking on an existing resource.

Use production PostgreSQL with `sslmode=verify-full` and an application-specific least-privilege
database principal. The runtime needs data access; migrations may need a
separate elevated principal. Do not allow all Azure addresses solely to make
deployment convenient. Database topology and connectivity are deployment
prerequisites, not assumed secure because a connection string works.

The primary azd profile creates private, Entra-only PostgreSQL and two separate
managed identities. Only the short-lived migration job uses the PostgreSQL
administrator identity. It maps a non-admin runtime role, applies versioned
migrations, and grants data access without schema/role administration. The
runtime obtains PostgreSQL tokens for new connections; no password/token is
stored in its database URI. The manual profile retains its explicit
bring-your-own-database/password option.

The portal/API is protected by tokens, but public ingress remains reachable.
Review private ingress, edge protection, tenant app-assignment requirements,
and abuse limits for your environment before production.

## MCP

Built-in tools are read-only catalog/budget operations, not privileged
deployment-management tools. Register external servers only when their
HTTPS host and managed-identity audience have been operator-approved.
An allowed URL is not a security review of the tools it serves.

APIM MCP policies apply at server scope. Use distinct MCP APIs/products or
audiences for different trust levels; do not assume native per-caller tool
filtering within one server. External MCP provider costs and tool side effects
are not controlled by the model budget ledger.

Do not log MCP response bodies or read them in a policy that would buffer a
stream. Do not send a privileged token to a caller-supplied host/audience.

## Logging and data handling

APIM sends request telemetry and `llm-emit-token-metric` custom metrics to a
workspace-based Application Insights resource. Ingestion uses APIM's
system-assigned identity with `Monitoring Metrics Publisher`; local
(instrumentation-key) authentication is disabled. Diagnostics log no headers,
bodies, LLM messages or client IP addresses. Metric dimensions are bounded
identifiers only (API, team, model, client application ID, caller type), never
prompt or completion content. The inference policy reads only the request's
`model` field (with a strict identifier pattern) to label the metric.
Token metrics are observability for chargeback reporting; the PostgreSQL ledger
remains the authoritative, pre-admission budget control.

Audit configuration changes, actor IDs, resource IDs, outcomes, and accounting
metadata. Do not persist prompts, model responses, access tokens, subscription
keys, or database URLs in the audit log. Apply appropriate retention/access
policies to operational logs and backups.

Local demo mode is not production authentication. It must remain loopback-only
and cannot be enabled with `NODE_ENV=production`. Demo replies and price data
are synthetic, not live Foundry traffic or pricing.

## Not included

This starter is not a compliance certification, penetration test, content
safety service, or prompt-injection prevention system. Content safety,
end-to-end private-network topology (beyond the azd profile's private database),
external-tool approval, automated invoice
reconciliation, and organizational incident response require an explicit
production design. Do not advertise these as enforced merely because APIM
supports related policies.
