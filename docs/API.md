# Application contract

All monetary values are non-negative, safe integers in **USD microdollars**
(1 USD = 1,000,000 microdollars). Prices are microdollars per million tokens.
Errors use `{ "error": { "code": "...", "message": "..." } }`.
Lists use `{ "items": [...] }`. Authentication is Bearer Entra access tokens;
demo mode is loopback-only and prominently labeled. Mutations require
`Gateway.Admin`; read access requires `Gateway.Reader` or `Gateway.Admin`.
User-only sessions may read principal-filtered team/model lists for the
playground, but not organization-wide budgets, audit, or management inventory.
Inference requires `Gateway.User` or `Gateway.Admin` AND membership in the
selected team's `principals` list. Principal IDs are validated Entra `oid` values,
not user-provided team headers.

App-only callers (managed identities, service principals, Entra agent
identities) may use the **data plane only** (`/openai/v1/chat/completions` and
`/mcp-tools/*`) when their token has no `scp`, carries the application-permission
app role `Gateway.Agent`, and their service-principal object ID (token `oid`) is
listed in the selected team's `applications`. The client application ID
(`azp`, or v1 `appid`) is recorded for attribution. App-only tokens are rejected
on every `/api/*` portal route, and a delegated user token never gains
`Gateway.Agent` even if the claim is present.

## Browser control plane

- `GET /api/config` (public): `{mode:"demo"|"azure", auth:{tenantId,clientId,apiScope}}`.
- `GET /api/session`: `{user:{id,name,roles:string[],type:"user"},mode,demoAgent?}`.
  `demoAgent:{id,name,clientAppId}` is returned only in the loopback demo.
- `GET /api/overview`: `{period,teams,deployments,mcpServers,budgetMicros,spentMicros,reservedMicros}`.
- `GET /api/teams`: list of
  `{id,name,monthlyBudgetMicros,spentMicros,reservedMicros,period,allowedModels:string[],principals:string[],applications:string[]}`.
- `POST /api/teams`: `{id,name,monthlyBudgetMicros,allowedModels,principals,applications?}`.
- `PUT /api/teams/:id`: `{name,monthlyBudgetMicros,allowedModels,principals,applications?}`.
  `applications` are service-principal object IDs of app-only callers. Omitting it
  on update preserves the stored list; an ID cannot be in both lists (`PRINCIPAL_CONFLICT`).
- `GET /api/models`: list of
  `{id,displayName,deploymentName,modelName,modelVersion,status,inputPriceMicrosPerMillion,outputPriceMicrosPerMillion,contextWindowTokens,maxOutputTokens,pricingValidUntil,enabled}`.
- `POST /api/models`: `{id,displayName,deploymentName,modelName,modelVersion,sku,capacity,inputPriceMicrosPerMillion,outputPriceMicrosPerMillion,contextWindowTokens,maxOutputTokens,pricingValidUntil,enabled}`.
  Provisions within the configured existing Foundry account, never an arbitrary
  caller-supplied account. Return 202 for asynchronous provisioning.
- `PUT /api/models/:id`: pricing/governance fields
  `{displayName,inputPriceMicrosPerMillion,outputPriceMicrosPerMillion,contextWindowTokens,maxOutputTokens,pricingValidUntil,enabled}`.
- `GET /api/mcp-servers`: list of
  `{id,name,path,backendUrl,authAudience,status,toolCostsCovered:false}`.
- `POST /api/mcp-servers`: `{id,name,path,backendUrl,authAudience}`.
  Register an HTTPS Streamable HTTP server in APIM only if its host/audience is
  operator-allowlisted. Never return tokens or subscription keys.
- `GET /api/usage`: list of
  `{id,createdAt,teamId,modelId,reservedMicros,chargedMicros,status,actorId,actorType:"user"|"app",clientAppId?,promptTokens?,completionTokens?}`.
  Status is `reserved`, `held`, `invalid_usage`, or `settled`; the first three
  still consume reserved budget. Model provisioning status is the provider
  state, or `demo` for local simulated models.
- `GET /api/audit`: list of `{id,timestamp,actor,actorType,action,target,outcome,detail}`;
  `actorType` is `user`, `app`, `system`, or `unknown` for rows written before v0.2.0.
- `POST /api/playground/chat`: `{teamId,modelId,messages:[{role,content}],maxCompletionTokens,simulateAgent?}`.
  `simulateAgent:true` runs as the fake demo agent identity and is rejected with
  `DEMO_ONLY` outside the loopback demo.
  Returns `{id,content,usage:{promptTokens,completionTokens,chargedMicros}}`.

## Inference data plane

`POST /openai/v1/chat/completions` accepts the supported OpenAI subset:
`{model,messages,max_completion_tokens,stream?:false}` plus `X-Team-Id`.
Returns an OpenAI-compatible Chat Completions response. Only plain-text
system/user/assistant messages are supported. Explicitly reject streaming,
tools, images, audio, `n != 1`, unknown options and unsupported model IDs.
Never trust cost, role, price, or usage data supplied by a caller.

Production inference requires both a valid end-user token and APIM's separate
managed-identity proof header `X-Gateway-Authorization` (Bearer token for
`GATEWAY_API_AUDIENCE`, validated against configured `APIM_PRINCIPAL_ID`
and the application role `Gateway.Invoke`).
APIM preserves the caller's Authorization header. The portal playground calls
APIM using the user's token, not Foundry directly.

### App-only (agent) callers

An agent running as a managed identity or service principal requests a token for
`api://<ENTRA_API_AUDIENCE>/.default` (client credentials or managed identity) and
calls `POST <APIM_GATEWAY_URL>/openai/v1/chat/completions` with `X-Team-Id`.
Prerequisites: an administrator assigns the agent's service principal the
`Gateway.Agent` app role on the user API enterprise application, and registers
the same object ID in the team's `applications`. Errors: `APP_ROLE_REQUIRED`
(403, role missing), `TEAM_ACCESS_DENIED` (403, not registered to the team or
model not allowed), `BUDGET_EXCEEDED` (402). Reservations, settlement and audit
record `actorType=app` and the client application ID.

In the loopback demo, send `X-Demo-Caller: app` on the data-plane routes to act
as the fake demo agent (registered to `demo-engineering` by the demo seed).

## Read-only tools exposed as MCP by APIM

- `GET /mcp-tools/models`: enabled models visible to the authenticated principal.
- `GET /mcp-tools/budget`: current budgets for that principal's teams.

APIM exports these REST operations as a separate MCP API. Both require the same
end-user or app-only (`Gateway.Agent`) and gateway authentication as inference;
app-only callers see only teams that register them, never peer identities. External MCP server execution
is subject to its own authentication/rate policies; external-provider charges
are **not** part of the model-cost ledger.

## Budget invariant

Before contacting Foundry, atomically reserve a conservative upper charge
against the UTC monthly team ledger using transactional row locking. Include
existing settled spend and all in-flight/uncertain reservations in admission.
Capture immutable pricing and month on each reservation. Settle once using
validated provider usage; do not release money on timeout, missing usage,
crashes, or uncertain outcomes. Never automatically retry inference or replay
an old request to Foundry. Reject stale pricing or unavailable durable storage.

The initial conservative maximum reserves the configured deployment context
window at the greater of input/output rates (plus any necessary separately
bounded output allowance). Administrators must verify actual deployment limits
and rate cards. Text input has a conservative UTF-8-byte/framing bound before
admission. This is a configured-price admission guarantee, NOT a cap on the
Azure invoice or bypass traffic. Keep uncertain reservations until an explicit,
auditable reconciliation with evidence.
