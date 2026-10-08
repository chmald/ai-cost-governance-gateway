# AI Cost Governance Gateway

> [!WARNING]
> **For testing and demonstration purposes only.** This is a personal reference demo provided "as is" under the [MIT License](LICENSE), without warranty or support. It is not an official Microsoft product or sample, has not been through a production security review, and is not intended for production use. Review, test, and harden it before reusing any part of it, deploy only to non-production subscriptions, and never use real customer or personal data.

Put **real-time budget caps** in front of Azure AI Foundry models and MCP tools.
Every team and agent gets a USD budget that is checked *before* each model call,
token usage is emitted as **chargeback metrics** per team, model and caller, and
MCP traffic flows through a **governed gateway** instead of directly to tools.

Under the hood it is a focused management portal and governance API with
**Azure API Management (APIM) as the AI and MCP gateway**. Manage deployments in
an existing Foundry account, assign team access, and admit inference requests
only when a conservative maximum charge fits the team's remaining budget.

> **Status:** locally validated (typecheck, unit/integration tests, offline
> loopback demo), **not yet live-deployed** to Azure. Treat the infrastructure
> templates as a reviewed starting point, not a production-proven deployment.

**Deployment:** `azd` is the primary path. It provisions supporting services,
configures Entra access when permitted, builds remotely in ACR, runs a gated
database migration job, and then releases the app. Actual Azure deployment
has not been performed; subscription, region, permissions and cost approval
remain operator decisions.

## What this project does

- A React/TypeScript portal for models, teams, budgets, MCP registrations,
  usage, audit events, and a text-chat playground.
- A TypeScript API for Foundry deployment management and gateway configuration,
  using Microsoft Entra roles and managed identity in Azure.
- A durable, transactional USD-microdollar ledger. Pending and uncertain
  inference charges reserve budget before a model call is sent.
- APIM policy and Bicep templates for the OpenAI-compatible inference route,
  read-only catalog/budget MCP tools, and authenticated MCP traffic.
- **Token metrics for chargeback:** APIM `llm-emit-token-metric` sends prompt/
  completion/total tokens to workspace-based Application Insights, by team,
  model, client application, caller type and API. Optional per-caller
  `llm-token-limit` throttling complements (never replaces) the ledger.
- **App-only callers:** agents, managed identities and service principals can
  call inference and the MCP tools with the `Gateway.Agent` application role.
  Each is registered to a team, spends that team's budget, and is attributed as
  an application in the ledger and audit trail. Users keep the delegated flow.
- An azd profile with private, Entra-only PostgreSQL, separate migration/runtime
  identities, and no local Docker or PostgreSQL requirement for cloud deployment.
- An explicitly labeled, loopback-only demo using simulated model responses;
  it does not require an Azure subscription or make Azure changes. It includes a
  fake app-only agent identity so the agent flow can be shown offline.

This is an original implementation inspired by the projects in
[Sources](docs/SOURCES.md), not a fork or a concatenation of their codebases.

## Run locally

Requires **Node.js 24 LTS** and npm 10 or newer.
`package-lock.json` resolves from the public npm registry. If you must use a
package mirror, configure it for your user (`npm config set registry <mirror-url>`);
npm rewrites the lockfile's registry host automatically, and integrity hashes are
still checked. Container builds accept `--build-arg NPM_CONFIG_REGISTRY=<mirror-url>`.

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

Open `http://localhost:5173`. The API listens on `127.0.0.1:3001`.
Demo data is local and deliberately synthetic. Keep demo mode bound to
loopback; it is not an authentication mechanism for shared environments.
To demonstrate an app-only agent offline, tick **Call as the demo agent
identity** in the playground, or send `X-Demo-Caller: app` to the inference route:

```powershell
$body = @{ model = 'demo-chat'; max_completion_tokens = 32; messages = @(@{ role = 'user'; content = 'Hello from an agent' }) } | ConvertTo-Json -Depth 4
Invoke-RestMethod http://127.0.0.1:3001/openai/v1/chat/completions -Method Post -ContentType application/json `
  -Headers @{ 'X-Team-Id' = 'demo-engineering'; 'X-Demo-Caller' = 'app' } -Body $body
```

The call is charged to `demo-engineering` (which registers the fake agent) and
appears under **Activity** as an `App` caller.

```powershell
npm run typecheck
npm test
npm run build
npm start
```

The built application is served by the API at `http://127.0.0.1:3001`.
See `.env.example` for runtime settings and `compose.yaml` for optional local
PostgreSQL. Production requires PostgreSQL; the local embedded database is
not a multi-replica production database.

## Architecture

```text
Browser portal -- Entra token --> Management API -- managed identity --> ARM
                                        |
                                        +--> team/model config + audit

Inference client -- Entra token + team --> APIM --> App Insights
 (user, or app-only agent /                |          (LLM token metrics)
  managed identity with Gateway.Agent)     |
                          caller token + APIM identity proof
                                           |
                                           v
                                  Governed inference API
                                           |
                        PostgreSQL atomic budget reservation
                                           |
                                  Foundry model inference
                                           |
                              verified usage -> settlement

MCP client --> APIM MCP --> read-only catalog/budget operations
                       \-> approved external MCP servers
```

The portal is a control plane, not a place to paste subscription keys.
The inference route cannot skip the budget ledger. The API independently
validates the caller and APIM's identity proof. An `X-Team-Id` header selects a
team; it never grants membership.

## Understand the budget guarantee

**This enforces admission against an administrator-configured price ledger.
It does not impose a hard cap on the Azure invoice.**

Each request reserves a conservative maximum using the configured model
limits and rates. Admission includes settled spend **and all outstanding
reservations**, so parallel requests cannot all spend the same remaining
balance. Successful responses settle using validated usage at the original
price snapshot. Timeouts, crashes, missing usage, and uncertain failures
retain their reservation; funds are not automatically released by a timer.

The initial supported surface is **non-streaming, text-only Chat Completions**
with an explicit output-token limit. Streaming, tools in model requests,
multimodal requests, and unpriced models are rejected rather than bypassing
budget checks. Conservative reservations can reject a request whose eventual
actual charge would have fit; that tradeoff is intentional.

The guarantee depends on correct and current model pricing/context limits,
durable storage, and routing all governed traffic through this service.
Infrastructure costs, taxes, currency changes, provisioned-throughput charges,
external MCP-provider fees, and direct Foundry calls are outside this ledger.
Model price inputs are operator-maintained, not a live Azure billing feed.

See [Budget design](docs/BUDGETS.md) for the invariant and failure handling,
[Security](docs/SECURITY.md) for trust boundaries, and
[API contract](docs/API.md) for endpoints and supported request shapes.
[Validation guide](docs/TESTING.md) distinguishes local checks from the
PostgreSQL, container, and deployed-Azure acceptance gates.

## Deploy with azd (primary)

Requires Node.js 24, PowerShell 7, Azure Developer CLI 1.30+ (major version 1),
Bicep CLI, an existing Foundry account, and the Azure/Entra permissions described
in [the deployment guide](docs/DEPLOYMENT.md).

After reviewing the deployment target and costs, the operator runs:

Sign in to the **intended** tenant explicitly; never rely on whichever account
`azd` or `az` used last:

```powershell
azd auth login --tenant-id <TENANT_ID>
azd env new gateway-dev
azd env set AZURE_TENANT_ID <TENANT_ID>
azd env set AZURE_SUBSCRIPTION_ID <SUBSCRIPTION_ID>
azd env get-values   # confirm the tenant and subscription
azd up
```

The azd hooks use only the azd sign-in. For the optional `az` commands in the
deployment guide (for example assigning `Gateway.Agent` to an agent identity),
sign in separately and select the subscription explicitly:

```powershell
az login --tenant <TENANT_ID>
az account set --subscription <SUBSCRIPTION_ID>
az account show --query "{tenant:tenantId, subscription:id}" -o table
```

Setup asks for missing subscription/region, existing Foundry resource group and
account, and APIM publisher contact. Supporting infrastructure, registration
setup, image build, database bootstrap/migration and app release are automated.
If tenant policy blocks Entra changes, setup stops with administrator actions;
it never weakens authentication to continue.

**Defaults are for evaluation:** APIM Developer and a Burstable PostgreSQL
server. Review production availability, sizing and cost before changing the
profile. Foundry is reused, not recreated. ACR build workers must reach the
public npm registry (or the mirror passed as a build argument).

See [the deployment guide](docs/DEPLOYMENT.md#enable-an-app-only-caller-agent-managed-identity-service-principal)
to enable an agent or managed identity, and
[token metrics](docs/DEPLOYMENT.md#token-metrics-and-application-insights) for
the Application Insights chargeback view. Release notes: [CHANGELOG](CHANGELOG.md).

For application updates, run `azd deploy gateway`; it uses the same migration
gate. `azd down` is blocked until explicit ledger/data-deletion acknowledgement.
The previous [manual deployment profile](infra/README.md) remains an advanced
bring-your-own-resource fallback, not the normal getting-started path.

## Disclaimer

This project is provided for testing, learning, and demonstration purposes only. It is not an official Microsoft product, sample, or service, and it is not supported under any Microsoft support program. Azure services, APIs, and pricing referenced here change over time — validate against current Microsoft Learn documentation before relying on any detail. Deploying it creates billable Azure resources; you are responsible for their cost, security, and cleanup.

## License

Released under the [MIT License](LICENSE).
