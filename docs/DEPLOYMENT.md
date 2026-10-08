# Deploy with Azure Developer CLI

`azure.yaml` is the primary deployment entry point. Infrastructure is under
`infra/azd`; `infra/main.bicep` and `scripts/Deploy-Gateway.ps1` remain the advanced
manual, bring-your-own-database/registry/identity alternative.

**This repository has been prepared locally, not deployed to Azure.** Choose and
approve a real subscription, region, service sizes and cost before executing
provisioning. A tenant-level CLI sign-in alone is not a subscription selection.

## Prerequisites

- Node.js 24, PowerShell 7, azd 1.30 or newer within major version 1, and the
  Bicep CLI (`bicep` on PATH).
- An existing public-Azure OpenAI or AIServices Foundry account with a custom
  subdomain, in the selected subscription. The account may use a different
  resource group. This workflow does not create Foundry or model deployments.
- Rights to provision the supporting Azure resources and create the narrow
  custom roles/role assignments in the new and existing Foundry resource groups.
- Entra permission to create/manage the three application registrations and
  their service-principal role assignments, or an administrator who supplies
  preconfigured registrations. Azure RBAC Owner does not itself grant Entra
  application-management rights.
- Connectivity from local tools to Azure/Graph and from ACR build workers to the
  public npm registry (`https://registry.npmjs.org/`). The lockfile resolves from
  that registry; to build through a mirror, pass
  `--build-arg NPM_CONFIG_REGISTRY=<mirror-url>` (or set it in `Dockerfile`).

No local Docker daemon, local PostgreSQL or database password is required by the
default deployment path. Native azd remote builds use ACR. azd may offer a local
Docker fallback after a remote build failure; resolve the remote
network/registry/permissions issue first.

## Sign in to the intended tenant and subscription

Operators often hold accounts in several tenants. Never rely on the ambient
`azd`/`az` login: always name the tenant and subscription explicitly and verify
them before any command that acquires a token or changes resources. `azd` and
`az` keep **separate** sign-ins; the azd hooks use only the azd sign-in, while
the optional operator commands below (and the manual profile) use `az`.

```powershell
# Required for the azd profile
azd auth login --tenant-id <TENANT_ID>

# Optional: only for the az-based operator commands in this guide
az login --tenant <TENANT_ID>
az account set --subscription <SUBSCRIPTION_ID>
az account show --query "{tenant:tenantId, subscription:id, name:name}" -o table
```

Use `--use-device-code` on either login when no browser is available. If
`az account show` reports a different tenant or subscription, sign in again
before continuing.

## First deployment

After the target and cost have been approved:

```powershell
azd auth login --tenant-id <TENANT_ID>
azd env new gateway-dev
azd env set AZURE_TENANT_ID <TENANT_ID>
azd env set AZURE_SUBSCRIPTION_ID <SUBSCRIPTION_ID>
azd env get-values   # confirm tenant and subscription before provisioning
azd up
```

Setup verifies that the selected subscription belongs to `AZURE_TENANT_ID` and
stops on a mismatch.

When values are missing, interactive setup asks for subscription ID, location,
existing Foundry resource group/account, and APIM publisher name/email.
Noninteractive execution requires them in advance:

```powershell
azd env set AZURE_SUBSCRIPTION_ID <subscription-guid>
azd env set AZURE_LOCATION <region>
azd env set FOUNDRY_RESOURCE_GROUP <existing-foundry-rg>
azd env set FOUNDRY_ACCOUNT_NAME <existing-foundry-account>
azd env set APIM_PUBLISHER_EMAIL <operator-email>
```

The Foundry endpoint and tenant are derived from the selected Azure resources,
not guessed from the current CLI tenant. An explicitly supplied inconsistent
endpoint or tenant is rejected. Setup refuses to adopt an unrelated existing
`rg-<environment>` resource group.

If Foundry disables public access or uses a default-deny network ACL, setup stops.
Review/customize routing, DNS or approved egress from the new isolated ACA VNet
before setting `FOUNDRY_NETWORK_REVIEWED=true`. This acknowledgement is not a
network configuration change: the profile never opens the existing account's
firewall or silently claims private Foundry connectivity.

## What happens automatically

1. Validate the selected subscription, Foundry account, tools and setup values.
   Create or validate a single-tenant SPA, delegated user API and separate
   gateway-proof API. Assign the bootstrap operator `Gateway.Admin`.
2. Provision ACR, APIM, Container Apps environment, private PostgreSQL/network/DNS,
   Log Analytics plus workspace-based Application Insights (APIM logger and
   inference diagnostics for LLM token metrics), two user-assigned identities and
   narrowly scoped Azure role assignments.
   PostgreSQL uses Entra-only authentication with no public database endpoint.
3. Let azd build/publish the existing Dockerfile remotely in ACR from the public
   npm registry (or the mirror you pass as a build argument).
4. In service predeploy, configure the SPA's actual `/auth.html` redirect and
   assign APIM the proof API's Application-only `Gateway.Invoke` role.
5. Resolve the published image to an immutable digest. Run a manual migration
   job using that digest in the private application network, with its own
   PostgreSQL administrator identity. Map the runtime principal to a non-admin
   database role, apply migrations and grant only necessary data permissions.
6. Only after successful migration, apply the Container App revision with the
   same digest. There is no publicly published placeholder app. Runtime startup
   checks schema compatibility instead of running DDL.
7. Check the actual deployed image, FQDN, `/readyz` and sign-in configuration.
   Live model and MCP acceptance tests remain operator checks before enabling
   consumers; health alone does not prove those integrations.

`azd deploy gateway` runs the same migration gate for updates. A failed or
uncertain job blocks release; there is no `continueOnError` escape hatch.
Do not run concurrent deployments against the same azd environment.

## Entra permissions and administrator handoff

`ENTRA_SETUP_MODE=auto` is the default. Setup creates only registrations owned
by this environment, identifies them by an environment/subscription marker,
and reuses their saved IDs on rerun. It does not create client secrets, persist
access tokens, assign broad Graph permissions to runtime identities, or grant
tenant-wide consent to unrelated APIs.

The user API exposes `access_as_user`, User-member roles `Gateway.Reader`,
`Gateway.User`, and `Gateway.Admin`, and the Application-member role
`Gateway.Agent` for app-only callers (saved as `GATEWAY_AGENT_ROLE_ID`; never
assigned automatically). The separate proof API exposes the
Application-member role `Gateway.Invoke`. All API tokens are v2 with distinct
application GUID audiences. Assignment is required on both API service
principals.

By default the signed-in operator is the initial admin. For service-principal/
CI deployment, set `GATEWAY_ADMIN_OBJECT_ID` to the intended Entra user object ID.
Additional consumers and team/model memberships are assigned deliberately,
not automatically opened to the whole tenant.

If Graph access, application registration policy or role assignment is blocked,
the hook stops before moving to the next stage. Have an appropriately authorized
administrator run setup, or use:

```powershell
azd env set ENTRA_SETUP_MODE existing
azd env set ENTRA_SPA_CLIENT_ID <spa-client-guid>
azd env set ENTRA_API_AUDIENCE <user-api-client-guid>
azd env set GATEWAY_API_AUDIENCE <proof-api-client-guid>
azd env set GATEWAY_ADMIN_OBJECT_ID <bootstrap-user-object-guid>
```

Existing mode validates rather than modifies registrations/assignments. An
administrator must supply the required roles/scope/assignment policy, assign the
bootstrap admin, and after provisioning register the reported SPA redirect and
assign `Gateway.Invoke` to the reported APIM principal. Rerun `azd up` or
`azd deploy gateway` after resolving the reported action. No failed
permission check is treated as successful setup.

Registration creation belongs to `preup`, not `preprovision`. An
`azd provision --preview` run only checks existing registrations and cannot
silently create them. If you want a provision preview before the first `up`,
explicitly approve/run `azd hooks run preup` first (this **does** perform Entra
setup), or supply administrator-configured registrations. No provision preview
was executed during this preparation task.

## Enable an app-only caller (agent, managed identity, service principal)

1. Identify the caller's **service principal object ID** (for a managed identity,
   its `principalId`; for an app registration, the enterprise application's
   object ID - not the client ID).
2. Assign it the `Gateway.Agent` app role on the user API enterprise application
   (a tenant administrator or an owner of that application):

   ```powershell
   az login --tenant <TENANT_ID>
   az account set --subscription <SUBSCRIPTION_ID>
   $apiSp = azd env get-value ENTRA_API_SERVICE_PRINCIPAL_ID
   $roleId = azd env get-value GATEWAY_AGENT_ROLE_ID
   $body = @{ principalId = '<AGENT_SP_OBJECT_ID>'; resourceId = $apiSp; appRoleId = $roleId } | ConvertTo-Json -Compress
   az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$apiSp/appRoleAssignedTo" `
     --headers "Content-Type=application/json" --body $body
   ```
3. In the portal, edit the team and add the same object ID under
   **Application identity object IDs**. The agent can now spend only that
   team's budget, on that team's allowed models.
4. The agent acquires a token for `api://<ENTRA_API_AUDIENCE>/.default` (for a
   managed identity, resource `api://<ENTRA_API_AUDIENCE>`) and calls
   `<APIM_GATEWAY_URL>/openai/v1/chat/completions` with `X-Team-Id`. Usage and
   audit rows show `actorType=app` and its client application ID.

Remove the app-role assignment or the team registration to revoke access.
Environments created before v0.2.0 receive `Gateway.Agent` on the next `azd up`
in `auto` mode; in `existing` mode an administrator adds it (until then app-only
callers stay disabled).

## Token metrics and Application Insights

APIM emits `llm-emit-token-metric` custom metrics (namespace `ai-gateway`) for
the inference route with dimensions **API ID, Team ID, Model, Client App ID,
Caller Type**. Application Insights (`APPLICATIONINSIGHTS_NAME`) is
workspace-based on the environment's Log Analytics workspace, accepts metrics
with dimensions, and disables instrumentation-key ingestion; APIM authenticates
with its managed identity (`Monitoring Metrics Publisher`). Diagnostics log no
headers, bodies or client IPs. Azure Monitor custom-metric limits apply (up to
5 custom dimensions; per-dimension and per-namespace time-series caps beyond
which new values are silently dropped), so keep team, model and agent counts
bounded or aggregate in Log Analytics.

Optional per-caller token throttling: `azd env set LLM_TOKENS_PER_MINUTE_PER_CALLER <n>`
enables `llm-token-limit` (default `0` = off). It complements, never replaces,
the prepaid ledger.

## Defaults, costs and production review

The profile defaults to APIM **Developer**, PostgreSQL **Burstable
Standard_B1ms**, 32 GiB storage, and a small Container Apps configuration.
These are evaluation defaults, not a production availability or capacity
recommendation. Regional SKU availability and quotas have not been established
without a real target.

Review `APIM_SKU`, `APIM_CAPACITY`, `POSTGRES_TIER`, `POSTGRES_SKU`,
`POSTGRES_STORAGE_SIZE_GB`, `GATEWAY_MIN_REPLICAS`, `GATEWAY_MAX_REPLICAS` and
`LLM_TOKENS_PER_MINUTE_PER_CALLER`.
Estimate APIM, compute, database, storage, logging, registry and model costs for
the selected region before provisioning. Empty MCP allowlists deny external
registrations; explicitly approve `MCP_ALLOWED_HOSTS` and
`MCP_ALLOWED_AUDIENCES` when needed.

The portal remains public HTTPS with Entra authorization and a separate APIM
proof on data-plane calls. PostgreSQL is private. Existing Foundry networking,
key authentication and other consumer RBAC assignments are not rewritten.
Prevent direct-model bypass separately; the budget ledger is not an Azure
invoice cap.

## Recovery, state and deletion

Local `.azure` environment state is ignored by Git except the nonsecret
deployment plan. It contains resource/application IDs, not access tokens or
database passwords. Protect it and never enable secret/debug output in logs.

Partial setup is resumable: rerun after fixing permissions or network issues.
Check the specific migration job execution for failures. Never erase or expire
financial reservations to make a failed release look healthy.
This profile creates a new database; it does not import an existing manual
deployment's ledger. Migrating an established gateway requires preserving and
reconciling that ledger before directing consumers at a new environment.

`azd down` deletes the environment's PostgreSQL ledger and supporting resources.
The project blocks it unless `AZD_ALLOW_DATA_DELETION=true` is explicitly set.
Back up and reconcile the ledger before acknowledging destruction. Entra
registrations are intentionally retained; review/delete them separately with
appropriate tenant authorization.

## Validation before deployment

```powershell
npm run typecheck
npm test
npm run test:azd
npm run build
npm run validate:azd
.\scripts\Test-AzdInfrastructure.ps1
azd hooks run prepackage --no-prompt
```

These checks do not provision or acquire Azure/Graph credentials. For production,
also run real PostgreSQL concurrency, the container build, live Entra/APIM proof
and native MCP calls, backend RBAC/network access, and current pricing/limits.
See `docs/TESTING.md`, `docs/SECURITY.md` and `infra/azd/README.md`.
