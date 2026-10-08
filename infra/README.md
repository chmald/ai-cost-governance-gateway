# Infrastructure operator reference

**Advanced manual profile.** The primary deployment path is now `azd up` using
`azure.yaml` and `infra/azd`. See `docs/DEPLOYMENT.md`. This document covers only
the older bring-your-own-PostgreSQL/ACR/Entra alternative.

**Scaffolding only; nothing has been deployed.** Azure configuration is deferred
until a real subscription, tenant registrations, existing Foundry account,
production PostgreSQL and network decisions are available. A tenant-only CLI
session is not a deployment target.

## Topology and trust boundary

One Azure Container Apps Consumption service serves the compiled React portal
and Fastify API on port 3001. APIM uses a system-assigned identity; the application
uses a separate user-assigned identity for Foundry, ARM and ACR image pull.
APIM is created first, then the application receives its principal ID, and a
separate module binds gateway APIs to the resulting application FQDN. This avoids
circular identity/hostname dependencies.

- `POST /openai/v1/chat/completions` in APIM forwards to the **same path** on the
  application. The application atomically reserves durable PostgreSQL budget
  before invoking Foundry. There is no APIM-to-Foundry inference backend.
- APIM validates tenant, audience and `Gateway.User`, `Gateway.Admin` or the
  app-only `Gateway.Agent` role, then rate-limits by the validated JWT `oid`.
  The app accepts delegated user tokens (`scp`) everywhere and app-only tokens
  only on the data plane, for teams that register the caller's object ID in
  `applications`. It preserves the caller `Authorization`
  and replaces any caller-provided `X-Gateway-Authorization` with an APIM identity
  token for the **different** `gatewayApiAudience`.
- The app must validate both tokens and require the proof token's `oid` to equal
  `APIM_PRINCIPAL_ID`, its `roles` to include `Gateway.Invoke`, and an app-only
  token (not a delegated user token). A forged header, a user's proof token or a direct
  application request without APIM proof must fail. This includes read-only
  tool endpoints. `X-Team-Id` selects a team; it never confers team membership.
- The public portal/control plane remains app-authenticated with Entra roles;
  the template does not add a catch-all APIM proxy to management routes. Public
  `/healthz`, static content and `/api/config` must disclose no secrets.
- Chat bodies are limited to 64 KiB at APIM and must also be bounded by the app.
  Only the one chat operation is configured. No retries or semantic caching can
  bypass reservations, replay uncertain requests, or expose another team's data.

The baseline is **application-layer isolation, not private network isolation**.
It publishes the portal's HTTPS ingress. Supplying `infrastructureSubnetId`
connects the new ACA environment to an already prepared subnet, but creates no
private endpoint, DNS zone, route, NAT gateway or firewall rules.

For an invoice-isolated deployment, plan and implement Foundry private endpoints
and DNS, restrict public access and local keys on the **existing** Foundry account,
remove other inference principals/routes, and provide private ACA connectivity.
APIM-to-application private connectivity and the portal ingress design require
an appropriate APIM/network tier and separate network work. PostgreSQL must have
private/routed connectivity or narrowly approved fixed egress; never enable
all-Azure or `0.0.0.0/0` DB firewall access to make this baseline work. The ledger
is a configured-price admission guarantee, not a cap on the Azure invoice.

## Prerequisites and parameter values

Run `.\scripts\Deploy-Gateway.ps1` for the offline checklist. It contacts no Azure
service by default, installs nothing, and changes no subscription context.

Required values in `main.parameters.example.json`:

| Parameter | Operator supplies |
| --- | --- |
| `location`, `appName`, `apimServiceName` | Approved region and names; APIM name is globally unique |
| `publisherName`, `publisherEmail` | Real APIM operator contact |
| `containerRegistryName` | Existing ACR in target RG, registry-RBAC mode, with the tested image |
| `imageRepositoryDigest` | `gateway@sha256:<64-hex-digest>`, never a mutable release tag |
| `databaseUrl` | ARM reference to an existing Key Vault secret containing production PostgreSQL URL |
| `azureTenantId`, `entraSpaClientId` | Existing tenant and operator-created SPA app registration IDs |
| `entraApiAudience`, `entraApiScope` | User API application GUID (v2 token audience) and exposed delegated scope URI |
| `gatewayApiAudience` | Separate operator-created internal proof API application GUID, used for MI resource and v2 token audience |
| `foundryResourceGroup`, `foundryAccountName`, `foundryEndpoint` | Existing Azure OpenAI-compatible Foundry account; same subscription, optionally different RG |
| `mcpAllowedHosts`, `mcpAllowedAudiences` | Exact external server DNS names and token resources; empty arrays deny registration |
| `llmTokensPerMinutePerCaller` (optional) | Per-caller `llm-token-limit` tokens/minute on inference; `0` (default) disables it |
| `logRetentionInDays` (optional) | Retention of the gateway telemetry Log Analytics workspace (default 30) |

Optional replica counts, tags, APIM SKU/capacity and an existing ACA infrastructure
subnet can be supplied. The default APIM `StandardV2` is a starting point, not a
capacity/availability or regional-support promise. `Developer` is evaluation-only.
MCP does not use APIM Consumption or workspaces.

Set `sslmode=verify-full` on PostgreSQL URLs and test server-certificate verification with the
application's driver. Apply migrations once before admitting traffic; the Docker
entrypoint does not silently modify a production database. The DB operator owns
availability, backup/restore, transaction capacity, credentials and rotation.

The secret parameter is `@secure()` and maps only to ACA secret `database-url`
and environment `DATABASE_URL` via `secretRef`. The helper rejects literal secrets
in parameters; use an ARM Key Vault parameter reference with deployment access
configured. No secret values or connection strings are output. Never enable shell
tracing around secrets or commit populated local parameter files.

## Entra registration is a manual prerequisite

No workload app registrations, tenant-wide permissions or consent are invented
or created by this template.

1. Register the portal as a SPA and configure its actual HTTPS redirect URI.
2. Register the user API with v2 access tokens, expose the delegated scope
   (`access_as_user`), authorize the SPA, and grant appropriate consent.
3. Define and assign `Gateway.Reader`, `Gateway.User`, `Gateway.Admin` app roles
   (User member type). Management mutations require Admin; model inference
   requires User/Admin plus the app's team membership check. Assign users/groups
   only as intended. To allow app-only callers (agents, managed identities,
   service principals), also define **`Gateway.Agent`** with
   `allowedMemberTypes: ["Application"]`, assign it to each caller's service
   principal, and register that object ID on a team as an application identity.
4. Register a **separate** internal gateway proof API, require v2 tokens, expose
   **`Gateway.Invoke`** with `allowedMemberTypes: ["Application"]` for APIM, and
   require service-principal assignment. Its app-role **value** must be exactly
   `Gateway.Invoke` (case-sensitive), not merely its display name.
5. After the first deployment creates APIM, use the nonsecret principal ID output
   to grant that APIM service principal the proof API's `Gateway.Invoke` role. An Entra administrator
   performs this assignment; Azure RBAC does not confer Entra application roles.
6. Configure each approved external MCP API's application permissions for APIM
   separately. Do not reuse the internal proof audience for an external server.

Until APIM can acquire its proof token, application data-plane calls fail closed.
Do not relax proof validation to work around identity propagation.
Set both APIs' `api.requestedAccessTokenVersion` to `2`. Their `aud` claim is the
API application/client GUID, not its `api://...` application ID URI. Set
`entraApiAudience` and `gatewayApiAudience` to these distinct GUIDs; the APIM MI
resource uses the proof API GUID too. The delegated scope remains a URI such as
`api://<user-api-guid>/access_as_user`. Do not copy that scope URI into `audience`.

## Azure permissions

The application UAMI receives:

- An account-scoped custom role with only Foundry account read and deployments
  read/write. No account creation/deletion, deployment deletion or key listing.
- `Cognitive Services OpenAI User`, scoped to that existing account, for the
  supported OpenAI inference path.
- A custom role assigned on this APIM service with service read, API read/write,
  and API policy read/write for operator-authorized external MCP registration.
  It cannot manage APIM subscriptions/keys, the service itself or Azure roles.
- `AcrPull` on the existing registry; repository-ABAC registries require a separate
  reviewed role adjustment before using this baseline.

APIM gets **no Foundry RBAC assignment**. Its tokens target the app proof API or
approved external MCP audiences only. Keep this APIM dedicated to the gateway:
the runtime registration identity can modify API policies within this service.
Protect Admin assignments, application code and deployment permissions accordingly.

The deployer needs resource deployment rights and permission to create the custom
roles and role assignments in both app and Foundry RGs. No subscription-wide
Contributor/Owner role is granted to a workload identity.

## Native MCP and external registrations

The backing REST API exposes exactly `GET /mcp-tools/models` and
`GET /mcp-tools/budget`. Native APIM MCP API `gateway-governance-mcp` exports those
two operation resource IDs as tools at `/mcp/governance/mcp`; it exposes no writes.
Both the MCP server policy and direct backing REST policy require
Reader/User/Admin. The application filters results by principal.

The server is represented by `Microsoft.ApiManagement/service/apis` with
`type: 'mcp'`; its `service/apis/tools` resources reference full backing operation
resource IDs. MCP API/tool resources pin `2025-09-01-preview`.

External registrations are created at runtime by the backend, not by
`main.bicep`. Their verified management shape is `type: 'mcp'`, an HTTPS
`serviceUrl` origin, and `mcpProperties` with `transportType: 'streamable'` and one
endpoint `{ name: 'message', uriTemplate: '/mcp' }`. The backend validates the
submitted host/audience against exact operator allowlists. The reference policy
is `policies\external-mcp.xml`; its `__AUTH_AUDIENCE__` marker must be XML-escaped
and replaced only after that validation. Never deploy the marker literally.
External servers receive a backend-specific APIM identity token, not the caller's
user token. Their provider charges are outside the model budget ledger.

Policies apply at MCP **server** level, not caller-specific per-tool level.
Separate MCP servers, audiences and backend authorization boundaries are required
for different tool-access groups. This scaffold does not claim tool filtering.
All APIs use JWT auth with `subscriptionRequired: false`; no subscription keys are
created or returned.

No policy reads/logs MCP response bodies and MCP policies set `buffer-response="false"`.
Only the bounded, non-streaming inference response is buffered so that
`llm-emit-token-metric` can read its `usage`. The template provisions a Log
Analytics workspace and workspace-based Application Insights (local auth
disabled) with an APIM logger that uses APIM's system-assigned identity
(`Monitoring Metrics Publisher`), plus an inference-API diagnostic with
`metrics: true` and no header/body logging. Token metrics use namespace
`ai-gateway` and dimensions API ID, Team ID, Model, Client App ID and Caller Type.
ACA application log export stays disabled. Any additional telemetry must contain
only operational metadata, not prompts, completions, auth headers, DB credentials
or tool payloads.

## Explicit staged workflow

1. Resolve all prerequisites and review costs/network design. Provision an ACR
   separately if needed using `registry.bicep`; no script does this automatically.
2. Run `npm ci`, the root build/test commands, then review/invoke the Docker build
   and push instructions printed by the checklist. The Docker image uses Node 24,
   production dependencies and the non-root `node` user. Both installation stages
   default to the public npm registry; pass `--build-arg NPM_CONFIG_REGISTRY=<mirror-url>`
   to build through a mirror.
3. Copy the example to `infra\main.parameters.local.json` and populate real values.
   The helper rejects unresolved markers, empty required fields, non-GUID tenant/
   subscription IDs, mutable images, wildcard MCP hosts and secret literals.
4. Run `.\scripts\Test-Infrastructure.ps1` for offline compilation and invariants.
5. Explicitly invoke `Deploy-Gateway.ps1 -Action Validate`, then `-Action WhatIf`
   with `-SubscriptionId`, `-ResourceGroup`, `-ParameterFile` and
   `-PrerequisitesReviewed`. These require actual Azure access. `-DryRun` validates
   locally without contacting Azure; PowerShell `-WhatIf` prevents cloud calls.
6. Review the Azure preview; only an explicit `-Action Deploy -ApproveDeployment`
   performs the deployment. The helper targets the supplied subscription on every
   Azure command and does not execute image builds, migrations, app registrations,
   networking changes or package installation on your behalf.
7. Complete Entra role assignment and DB initialization. The built image provides
   `node apps/api/dist/cli.js migrate` for an explicitly authorized migration run
   with the correct production environment and database credentials; it does not
   require development `tsx` dependencies. Runtime startup and `/readyz` verify
   schema compatibility without creating or changing production tables.
   Verify unauthorized
   direct inference/tool requests fail, APIM user+proof flow succeeds, unknown
   routes fail, MCP `initialize`/`tools/list`/`tools/call` works, and MCP responses
   stream without content logging. Verify ledger concurrent/reservation failures
   and current model rate cards before enabling users.

Local Bicep compilation and policy XML parsing do **not** validate APIM runtime
policy support, regional SKU availability, Entra consent, RBAC propagation,
existing-resource networking or deployed native-MCP token forwarding. These are
mandatory deployment acceptance checks, not results claimed by this scaffold.

## Verified reference locations

Schemas/behavior were checked against Microsoft Learn on September 18, 2026:

```text
https://learn.microsoft.com/azure/api-management/manage-mcp-servers-rest-api
https://learn.microsoft.com/azure/templates/microsoft.apimanagement/2025-09-01-preview/service/apis
https://learn.microsoft.com/azure/templates/microsoft.apimanagement/2025-09-01-preview/service/apis/tools
https://learn.microsoft.com/azure/api-management/export-rest-mcp-server
https://learn.microsoft.com/azure/api-management/authentication-managed-identity-policy
https://learn.microsoft.com/entra/identity-platform/access-token-claims-reference
https://learn.microsoft.com/azure/api-management/validate-content-policy
https://learn.microsoft.com/azure/developer/ai/keyless-connections
https://learn.microsoft.com/azure/templates/microsoft.app/2025-01-01/containerapps
https://learn.microsoft.com/azure/templates/microsoft.app/2025-01-01/managedenvironments
https://learn.microsoft.com/azure/api-management/llm-emit-token-metric-policy
https://learn.microsoft.com/azure/api-management/llm-token-limit-policy
https://learn.microsoft.com/azure/api-management/api-management-howto-app-insights
```
