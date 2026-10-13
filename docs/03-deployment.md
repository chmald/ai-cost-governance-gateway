[README](../README.md) › [docs index](./00-reproduce-this-demo.md) › 03 Deployment

# 03 - Deployment (azd)

<p>
  <img src="./assets/icons/azure-devops.svg" width="40" alt="Azure Developer CLI">
  <img src="./assets/icons/entra-id.svg" width="40" alt="Microsoft Entra ID">
  <img src="./assets/icons/api-management.svg" width="40" alt="API Management">
  <img src="./assets/icons/container-apps.svg" width="40" alt="Container Apps">
  <img src="./assets/icons/container-registry.svg" width="40" alt="Container Registry">
  <img src="./assets/icons/postgresql.svg" width="40" alt="Azure Database for PostgreSQL">
</p>

<p>
  <img src="./assets/badges/azd-up.svg" alt="deploy: azd up">
  <img src="./assets/badges/azd-version.svg" alt="azd: 1.30+">
  <img src="./assets/badges/default.svg" alt="profile: default">
  <img src="./assets/badges/not-live-deployed.svg" alt="Azure deploy: not yet live-deployed">
</p>

The primary deployment runbook. `azure.yaml` is the entry point; `azd up` provisions the supporting services, configures Entra access when permitted, builds the image remotely in ACR, runs a gated database migration job, and then releases the app. Foundry is reused by default; `FOUNDRY_SETUP_MODE=create` opts in to a dedicated account/project. For a bring-your-own-resource build without azd, see [03b - Manual deployment](./03b-manual-deployment.md).

## At a glance

| | | |
|---|---|---|
| <img src="./assets/icons/azure-devops.svg" width="24" alt=""> | **Tool** | `azd up` (azd 1.30+ within major version 1) with `preup`, `preprovision`, service `prepackage`/`predeploy`/`postdeploy` and `predown` hooks |
| <img src="./assets/icons/entra-id.svg" width="24" alt=""> | **Entra** | Three registrations created or validated in `preup` (`ENTRA_SETUP_MODE=auto`), or supplied by an administrator (`existing`) |
| <img src="./assets/icons/resource-group.svg" width="24" alt=""> | **Creates** | Resource group, ACR, APIM, Container Apps environment, private PostgreSQL 17, VNet + private DNS, Log Analytics, Application Insights, two managed identities, scoped roles; optional dedicated Foundry account/project |
| <img src="./assets/icons/container-apps-environment.svg" width="24" alt=""> | **Release gate** | Migration job on the exact image digest must succeed before the revision is applied |
| <img src="./assets/icons/cost-management.svg" width="24" alt=""> | **Defaults** | Evaluation sizing: APIM Developer, PostgreSQL Burstable `Standard_B1ms` / 32 GiB, small Container Apps footprint |
| <img src="./assets/icons/powershell.svg" width="24" alt=""> | **No local Docker** | Remote ACR build; no local PostgreSQL or database password |

> [!WARNING]
> **This repository has been validated locally, not deployed to Azure.** Choose and approve a real subscription, region, service sizes and cost before provisioning. A tenant-level CLI sign-in alone is not a subscription selection. Treat the templates as a reviewed starting point.

> [!WARNING]
> **Phase 0 is not optional.** Operators often hold accounts in several tenants. `azd` and `az` keep **separate** sign-ins, and the ambient account drifts. Always name the tenant and subscription explicitly and verify them before any command that acquires a token or changes resources. A bare `azd up` can target the wrong tenant.

## Fast path - azd up

[![azd deployment flow](./assets/azd-deployment-flow.png)](./assets/azd-deployment-flow.png)

<sub>Editable source: [`assets/azd-deployment-flow.drawio`](./assets/azd-deployment-flow.drawio) - regenerate with `python scripts/export_diagrams.py docs/assets`.</sub>

| Step | | Action | Gate |
|---|---|---|---|
| **0** | <img src="./assets/icons/entra-id.svg" width="28" alt=""> | Sign in to the intended tenant (azd, and az for optional commands) | ☐ `azd env get-values` and `az account show` show the target |
| **1** | <img src="./assets/icons/gear.svg" width="28" alt=""> | Create the environment and set required values | ☐ Tenant, subscription, region, Foundry, publisher set |
| **2** | <img src="./assets/icons/azure-devops.svg" width="28" alt=""> | `azd up` | ☐ Every hook passes; release gate succeeds |
| **3** | <img src="./assets/icons/monitor.svg" width="28" alt=""> | Live acceptance checks | ☐ Sign-in, APIM proof, inference, MCP, metrics verified |
| **4** | <img src="./assets/icons/entra-workload-id.svg" width="28" alt=""> | Enable agents and chargeback views | ☐ `Gateway.Agent` assigned per agent; metrics split by team |

### Phase 0 - Authenticate to the right tenant

<img src="./assets/icons/entra-id.svg" width="20" alt=""> Resolve the intended tenant and subscription first (ask the subscription owner if unknown - never guess), then:

```powershell
# Required for the azd profile (the hooks use only the azd sign-in)
azd auth login --tenant-id <TENANT_ID>

# Optional: only for the az-based operator commands in this guide
az login --tenant <TENANT_ID>
az account set --subscription <SUBSCRIPTION_ID>
az account show --query "{tenant:tenantId, subscription:id, name:name}" -o table
```

Use `--use-device-code` on either login when no browser is available. If `az account show` reports a different tenant or subscription, sign in again before continuing.

### Phase 1 - Create the environment

<img src="./assets/icons/gear.svg" width="20" alt=""> After the target and cost have been approved:

```powershell
azd env new gateway-dev
azd env set AZURE_TENANT_ID <TENANT_ID>
azd env set AZURE_SUBSCRIPTION_ID <SUBSCRIPTION_ID>
azd env get-values   # confirm tenant and subscription before provisioning
```

When values are missing, interactive setup asks for subscription ID, location, existing Foundry resource group/account in default reuse mode, and APIM publisher name/email. Noninteractive reuse execution requires them in advance:

```powershell
azd env set AZURE_LOCATION <region>
azd env set FOUNDRY_RESOURCE_GROUP <existing-foundry-rg>
azd env set FOUNDRY_ACCOUNT_NAME <existing-foundry-account>
azd env set APIM_PUBLISHER_NAME "<operator or team name>"
azd env set APIM_PUBLISHER_EMAIL <operator-email>
```

Optional sizing, allowlist and throttle settings are listed in [12 - Configuration reference](./12-configuration-reference.md#platform-sizing-and-policy).

To place only API Management in another region, set `azd env set APIM_LOCATION southcentralus`. If unset or empty, APIM uses `AZURE_LOCATION`. Verify the selected APIM SKU in that region and account for cross-region latency and transfer costs. Container Apps, PostgreSQL, Foundry and Application Insights stay in the primary region.

Changing `APIM_LOCATION` after provisioning creates a differently named APIM service because an existing service cannot be relocated by changing its location property. The original service is retained by incremental deployment and can continue billing; review and explicitly delete it only after the replacement and its identity/policies are verified. Rerun the full provision/deploy lifecycle to wire the replacement outputs and proof identity. An APIM-only region override does not fix a Container Apps capacity failure in `AZURE_LOCATION`.

To move Container Apps while retaining the existing private PostgreSQL server, keep `AZURE_LOCATION` unchanged and set `azd env set CONTAINER_APPS_LOCATION southcentralus`. The environment, application and migration job use that region; PostgreSQL and Foundry keep their primary-region names and data. A different-region environment uses a distinct deterministic name, a dedicated `10.43.0.0/16` VNet (`10.43.0.0/23` application subnet), bidirectional peering to the primary `10.42.0.0/16` VNet, and a link to the existing PostgreSQL private DNS zone. The database NSG permits TCP 5432 only from the selected application subnet. Public database access stays disabled.

Review address overlap before connecting these networks elsewhere. Cross-region traffic adds latency and transfer costs. The resolved `AZURE_CONTAINER_APPS_LOCATION` output drives both release and migration templates. Retry with `azd up`; failed original environments remain until explicitly cleaned up. Moving an already deployed application or migration job across regions requires an explicit replacement plan; this override is suitable before the first application release.

The Foundry endpoint is derived from the verified reuse account or deterministic create-mode account name, not guessed from the current CLI tenant. An explicitly supplied inconsistent endpoint or tenant is rejected. Setup verifies that the selected subscription belongs to `AZURE_TENANT_ID` and stops on a mismatch. Setup refuses to adopt an unrelated existing `rg-<environment>` resource group.

> [!IMPORTANT]
> If Foundry disables public access or uses a default-deny network ACL, setup stops (`FOUNDRY_NETWORK_RESTRICTED`). Review/customize routing, DNS or approved egress from the new isolated ACA VNet before setting `FOUNDRY_NETWORK_REVIEWED=true`. This acknowledgement is not a network configuration change: the profile never opens the existing account's firewall or silently claims private Foundry connectivity.

### Dedicated Foundry demo (opt-in)

In a **fresh** environment, after Phase 0 and regional/cost approval:

```powershell
azd env new ai-gateway
azd env set AZURE_TENANT_ID <DEMO_TENANT_ID>
azd env set AZURE_SUBSCRIPTION_ID <DEMO_SUBSCRIPTION_ID>
azd env set AZURE_LOCATION eastus2
azd env set FOUNDRY_SETUP_MODE create
azd env set FOUNDRY_PROJECT_NAME gateway-project   # optional; this is the default
azd env set APIM_PUBLISHER_NAME "<operator or team name>"
azd env set APIM_PUBLISHER_EMAIL <operator-email>
azd env get-values   # verify target; do not provision until regional eligibility is confirmed
```

The azd environment name controls the group: `ai-gateway` → **`rg-ai-gateway`**. Do not set `FOUNDRY_RESOURCE_GROUP`, `FOUNDRY_ACCOUNT_NAME`, `FOUNDRY_CREATED_ACCOUNT_NAME` or `FOUNDRY_ENDPOINT` yourself in create mode. Setup derives a globally unique account name from the subscription/environment/region, persists it once as `FOUNDRY_CREATED_ACCOUNT_NAME`, and saves the same account coordinates and HTTPS endpoint used by Bicep and the gateway revision. Changing that target, or switching a populated reuse environment to create, is rejected; use a fresh environment instead.

Both preup and preprovision can validate before the account exists (404 only; permissions errors still stop). They never create Foundry resources: Bicep owns the AIServices **S0**, Entra-only (`disableLocalAuth: true`) account and project in the demo group. Owned-resource retries check tags, region, account configuration and project ownership before continuing. Existing-account drift is not silently repaired by opening its firewall.

The new account deliberately has **public HTTPS access** so the isolated ACA network can reach it; there are no Foundry private endpoints, hosted agents, AI Gateway preview tier, or initial model deployments. After release, use the gateway portal to deploy an on-demand chat model and configure verified pricing/limits before inference. Account/project identity conventions follow the shared landing-zone architecture, without importing its hosted-agent/model resources or broad Contributor grants.

All template-managed new resources target the demo group; Azure Container Apps may also create a provider-managed infrastructure resource group. Entra registrations are tenant-scoped, not resource-group resources.

> [!WARNING]
> Check **subscription-specific** PostgreSQL eligibility before `azd up`, not just the region's product availability. If the regional capability response reports `OfferRestricted: Enabled` with no `supportedServerEditions`, stop and request regional enablement under Service and subscription limits, or obtain approval for another region. Do not provision partially billable infrastructure in a known-blocked region. The requested `eastus2` example is not an eligibility guarantee.

The `preup` and `preprovision` hooks enforce this check before Foundry preparation or Entra setup, stopping with `POSTGRES_REGION_RESTRICTED` when the location is restricted or no compute tiers are supported. They do not silently change the region.

### Phase 2 - Run azd up

<img src="./assets/icons/azure-devops.svg" width="20" alt=""> `azd up` runs these hooks in order. Each one is `continueOnError: false`.

| Hook | Command | What it does |
|---|---|---|
| `preup` | `node ./scripts/azd/run.mjs prepare` | Validates tools, subscription, region and Foundry reuse/create target; creates or validates the SPA, user API and proof API registrations; assigns the bootstrap operator `Gateway.Admin` |
| `preprovision` | `run.mjs check-target` | Read-only validation of the same target; never creates or changes Entra registrations |
| service `prepackage` | `run.mjs check` | Offline configuration check before packaging |
| service `predeploy` | `run.mjs migrate` | Sets the SPA `/auth.html` redirect and APIM's `Gateway.Invoke` assignment; resolves the published image to a digest; deploys and runs the migration job on that digest; saves `GATEWAY_DEPLOY_IMAGE` only on success |
| service `postdeploy` | `run.mjs verify` | Confirms the deployed image, FQDN, `/readyz` and sign-in configuration |
| `predown` | `run.mjs guard-down` | Blocks `azd down` unless `AZD_ALLOW_DATA_DELETION=true` |

```powershell
azd up
```

What happens automatically:

1. Validate the selected subscription, Foundry account, tools and setup values. Create or validate a single-tenant SPA, delegated user API and separate gateway-proof API. Assign the bootstrap operator `Gateway.Admin`.
2. Provision ACR, APIM, Container Apps environment, private PostgreSQL/network/DNS, Log Analytics plus workspace-based Application Insights (APIM logger and inference diagnostics for LLM token metrics), two user-assigned identities and narrowly scoped Azure role assignments. Create mode also provisions the dedicated Foundry account/project before granting runtime Foundry access. PostgreSQL uses Entra-only authentication with no public database endpoint.
3. Let azd build/publish the existing Dockerfile remotely in ACR from the public npm registry (or the mirror you pass as a build argument).
4. In service predeploy, configure the SPA's actual `/auth.html` redirect and assign APIM the proof API's Application-only `Gateway.Invoke` role.
5. Resolve the published image to an immutable digest. Run a manual migration job using that digest in the private application network, with its own PostgreSQL administrator identity. Map the runtime principal to a non-admin database role, apply migrations and grant only necessary data permissions.
6. Only after successful migration, apply the Container App revision with the same digest. There is no publicly published placeholder app. Runtime startup checks schema compatibility instead of running DDL.
7. Check the actual deployed image, FQDN, `/readyz` and sign-in configuration. Live model and MCP acceptance tests remain operator checks before enabling consumers; health alone does not prove those integrations.

The full engineering contract, including outputs and the exact release-gate ordering, is in [11 - azd integration contract](./11-azd-integration-contract.md).

> [!TIP]
> Want a provision plan first? Registration creation belongs to `preup`, so `azd provision --preview` only checks existing registrations. Either supply administrator-configured registrations, or deliberately run `azd hooks run preup` (which **does** perform Entra setup) before the plan.

### Phase 3 - Entra permissions and administrator handoff

<img src="./assets/icons/app-registrations.svg" width="20" alt=""> `ENTRA_SETUP_MODE=auto` is the default. If Graph access, application registration policy or role assignment is blocked, the hook stops with the administrator action required; it never weakens authentication to continue. Switch to `existing` mode with administrator-supplied registrations:

```powershell
azd env set ENTRA_SETUP_MODE existing
azd env set ENTRA_SPA_CLIENT_ID <spa-client-guid>
azd env set ENTRA_API_AUDIENCE <user-api-client-guid>
azd env set GATEWAY_API_AUDIENCE <proof-api-client-guid>
azd env set GATEWAY_ADMIN_OBJECT_ID <bootstrap-user-object-guid>
```

Roles, scope, assignment policy and the full handoff list are in [07 - Identity and security](./07-identity-and-security.md#entra-setup-and-administrator-handoff). For service-principal/CI deployment, always set `GATEWAY_ADMIN_OBJECT_ID` to the intended Entra user object ID.

### Phase 4 - Live acceptance checks

<img src="./assets/icons/monitor.svg" width="20" alt=""> `postdeploy` proves the app is running, not that the integrations work. Before enabling consumers:

| Check | | How | Gate |
|---|---|---|---|
| Sign-in | <img src="./assets/icons/browser.svg" width="28" alt=""> | Open `GATEWAY_URL`; sign in as the bootstrap admin | ☐ Portal shows Azure mode, no demo banner |
| Direct calls fail | <img src="./assets/icons/container-apps.svg" width="28" alt=""> | Call `GATEWAY_URL/openai/v1/chat/completions` directly with a valid token | ☐ `403 GATEWAY_PROOF_REQUIRED` |
| Governed inference | <img src="./assets/icons/api-management.svg" width="28" alt=""> | Price a model, create a team, call `APIM_GATEWAY_URL/openai/v1/chat/completions` | ☐ `200`, a settled row in Activity |
| Budget refusal | <img src="./assets/icons/cost-budgets.svg" width="28" alt=""> | Create a team with a tiny budget and call it | ☐ `402`, no new settled spend |
| App-only caller | <img src="./assets/icons/entra-workload-id.svg" width="28" alt=""> | Assign `Gateway.Agent`, register the object ID, call with a `.default` token | ☐ Activity shows `App` |
| MCP | <img src="./assets/icons/toolbox.svg" width="28" alt=""> | `initialize`, `tools/list`, `tools/call` on `/mcp/governance/mcp` | ☐ Tools respond, stream not buffered |
| Token metrics | <img src="./assets/icons/application-insights.svg" width="28" alt=""> | Metrics explorer, namespace `ai-gateway`, split by `Team ID` | ☐ Values appear for the test team |

Then [enable app-only callers](./07-identity-and-security.md#enable-an-app-only-caller) and set up [chargeback views](./08-observability-and-token-metrics.md#querying-chargeback-data).

## Updates

For application updates, run `azd deploy gateway`; it uses the same migration gate. A failed or uncertain job blocks release; there is no `continueOnError` escape hatch. Do not run concurrent deployments against the same azd environment.

```powershell
azd deploy gateway
```

## Defaults, costs and production review

The profile defaults to APIM **Developer**, PostgreSQL **Burstable Standard_B1ms**, 32 GiB storage, and a small Container Apps configuration (0.5 vCPU / 1 GiB, 1-3 replicas). These are evaluation defaults, not a production availability or capacity recommendation. Regional SKU availability and quotas have not been established without a real target.

| Resource | Product | Default | Review before production |
|---|---|---|---|
| <img src="./assets/icons/api-management.svg" width="20" alt=""> APIM | API Management | `APIM_SKU=Developer`, `APIM_CAPACITY=1` | Developer has no production SLA; consider StandardV2 / PremiumV2 |
| <img src="./assets/icons/postgresql.svg" width="20" alt=""> Database | Azure Database for PostgreSQL | `Burstable`, `Standard_B1ms`, 32 GiB | Tier, SKU, storage, HA, geo-backup |
| <img src="./assets/icons/container-apps.svg" width="20" alt=""> App | Container Apps | `GATEWAY_MIN_REPLICAS=1`, `GATEWAY_MAX_REPLICAS=3` | Capacity and concurrency |
| <img src="./assets/icons/policy.svg" width="20" alt=""> Token throttle | API Management | `LLM_TOKENS_PER_MINUTE_PER_CALLER=0` | Enable if bursts matter |
| <img src="./assets/icons/toolbox.svg" width="20" alt=""> MCP allowlists | API Management | empty (deny) | Approve `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_AUDIENCES` deliberately |

Estimate APIM, compute, database, storage, logging, registry and model costs for the selected region before provisioning - see [02 - Prerequisites](./02-prerequisites.md#cost). The portal remains public HTTPS with Entra authorization and a separate APIM proof on data-plane calls. PostgreSQL is private. Existing Foundry networking, key authentication and other consumer RBAC assignments are not rewritten. Prevent direct-model bypass separately; the budget ledger is not an Azure invoice cap.

## Recovery, state and deletion

Local `.azure` environment state is ignored by Git. It contains resource/application IDs, not access tokens or database passwords. Protect it and never enable secret/debug output in logs.

Partial setup is resumable: rerun after fixing permissions or network issues. Check the specific migration job execution (`GATEWAY_MIGRATION_EXECUTION`) for failures. Never erase or expire financial reservations to make a failed release look healthy. This profile creates a new database; it does not import an existing manual deployment's ledger. Migrating an established gateway requires preserving and reconciling that ledger before directing consumers at a new environment.

> [!CAUTION]
> `azd down` deletes the environment's PostgreSQL ledger and supporting resources, including the dedicated Foundry account/project and any portal-created model deployments in create mode. The project blocks it unless `AZD_ALLOW_DATA_DELETION=true` is explicitly set. Back up and reconcile the ledger before acknowledging destruction. Entra registrations are intentionally retained; review/delete them separately with appropriate tenant authorization.

```powershell
azd env set AZD_ALLOW_DATA_DELETION true   # only after the ledger is backed up and reconciled
azd down
```

## Validation before deployment

These checks do not provision or acquire Azure/Graph credentials:

```powershell
npm run typecheck
npm test
npm run test:azd
npm run build
npm run validate:azd
.\scripts\Test-AzdInfrastructure.ps1
azd hooks run prepackage --no-prompt
```

For production, also run real PostgreSQL concurrency, the container build, live Entra/APIM proof and native MCP calls, backend RBAC/network access, and current pricing/limits. See [04 - Testing](./04-testing.md), [07 - Identity and security](./07-identity-and-security.md) and [11 - azd integration contract](./11-azd-integration-contract.md).

---

Next: [03b - Manual deployment](./03b-manual-deployment.md) →

*Last updated: 2026-10-08*
