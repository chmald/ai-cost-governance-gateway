# azd infrastructure profile

This additive profile leaves `infra/main.bicep`, its modules and policies
unchanged. It implements `docs/AZD-CONTRACT.md`; use the repository's azd hooks
and root `azure.yaml`, not direct deployment of a placeholder application.

## Deployment boundary and release contract

- `main.bicep` is **subscription scoped**. It creates `rg-${AZURE_ENV_NAME}`
  with `azd-env-name`, two distinct user-assigned identities, Basic ACR,
  APIM, a private PostgreSQL 17 server/database and DNS/network, and an ACA
  workload-profile environment containing only the **Consumption** profile.
  It creates **no Container App or migration job**, hence no first revision.
- `gateway.bicep` is **resource-group scoped**, applied by azd's revision-based
  service deployment. Its required `imageName` is
  `${GATEWAY_DEPLOY_IMAGE}`: the immutable digest resolved by service predeploy
  from native publish's `${SERVICE_GATEWAY_IMAGE_NAME}`. There is no
  placeholder, empty-image fallback, local Docker invocation or image rebuild.
  Keep `azure.yaml`'s service API version at `2025-01-01`.
- `migration-job.bicep` is a separate **resource-group scoped** deployment
  created/updated by the **service predeploy hook**, which azd 1.30.0 runs
  **after** Publish has saved `SERVICE_GATEWAY_IMAGE_NAME`.
  `migration-job.parameters.json` documents the complete substitution contract.
  The hook compiles `migration-job.bicep` using local `bicep build --stdout`
  and submits the template and resolved parameters to ARM using azd
  authentication. It does not use Azure CLI authentication or rely on ARM
  to expand `${...}` placeholders. The hook validates the published
  registry image, resolves its immutable digest, creates/updates and starts
  the job with that same digest, and waits for success. It saves
  `GATEWAY_DEPLOY_IMAGE` only after successful execution before allowing native
  deploy. It must reject a missing, stale or failed
  migration gate. Use only service predeploy, not postpublish or recursive deploy;
  this covers `azd up`, direct `azd deploy` and `azd deploy --from-package`.
- The job runs `node apps/api/dist/bootstrap.js`, manually, one replica, a
  600-second timeout, and **zero automatic retries**. An explicit operator
  rerun uses the bootstrap's idempotency and principal-mapping checks.
  It is intentionally **not** tagged `azd-service-name=gateway`: discovery
  must not confuse the job with the application.
- Foundation outputs include the deterministic app ID and expected URL
  `https://<app-name>.<ACA-environment-defaultDomain>`. APIM uses that same URL
  before the application exists. Service predeploy configures the SPA redirect
  and `Gateway.Invoke` assignment; postdeploy must compare the actual FQDN to
  the expected URL and verify readiness. A provision-only URL is not proof of
  a running app.

All shared output names are defined by `docs/AZD-CONTRACT.md` and checked by the
offline test, including `AZURE_LOG_ANALYTICS_WORKSPACE_ID` and the
workspace-based Application Insights outputs `APPLICATIONINSIGHTS_NAME` /
`APPLICATIONINSIGHTS_ID` (APIM logger + inference diagnostics for LLM token metrics).
The service also outputs actual `SERVICE_GATEWAY_ENDPOINT_URL`; it intentionally
does not overwrite the expected `GATEWAY_URL` before the hook compares them.
In azd 1.30.0, `deploymentHost` does **not** look up a named template output:
it examines the deployment result's `Resources` (ARM `outputResources`) and
parses the deployed resource IDs. The service template deploys exactly one
`Microsoft.App/containerApps` resource and no competing app/job host.

The migration template's exact ARM parameter contract is:
`environmentName`, `location`, `jobName`, `containerAppsEnvironmentName`, `containerRegistryName`,
`migrationIdentityId`, `migrationClientId`, `imageName`, `postgresHost`,
`postgresDatabase`, `postgresAppRole`, `migrationPrincipalName`,
and `runtimePrincipalId`. The hook supplies the foundation environment and
registry names; the template resolves their resource ID and login server.
It tags the job with `azd-env-name`, never `azd-service-name`, and sets
`GATEWAY_MODE=azure` and `DATABASE_AUTH=entra` for bootstrap.

## Inputs and development defaults

Subscription, tenant and location are **operator-selected at actual deployment**;
this profile never infers a usable subscription from an existing CLI login.
Foundry inputs refer to an existing account **in that same subscription**.
The account must be reachable from the app; this profile does not change its
firewall, private endpoints, deployed models or DNS.

Required environment inputs are the contract's Azure/Foundry/Entra values plus
`APIM_PUBLISHER_NAME` and `APIM_PUBLISHER_EMAIL`. `FOUNDRY_ENDPOINT` and
`ENTRA_SPA_CLIENT_ID`/`ENTRA_API_SCOPE` are passed to the release, not used to
create new Foundry or Graph resources. User and proof API audiences must remain
distinct; setup validates that invariant.

| Optional environment value | Default | Meaning |
| --- | --- | --- |
| `APIM_SKU` | `Developer` | Evaluation only, no production SLA |
| `APIM_CAPACITY` | `1` | Developer is always one unit; other allowed SKUs use this value |
| `POSTGRES_TIER` | `Burstable` | Development compute tier |
| `POSTGRES_SKU` | `Standard_B1ms` | Must match tier and regional availability |
| `POSTGRES_STORAGE_SIZE_GB` | `32` | Premium SSD, no automatic storage growth |
| `GATEWAY_MIN_REPLICAS` | `1` | Keep readiness available; nonzero baseline usage |
| `GATEWAY_MAX_REPLICAS` | `3` | Review capacity/concurrency before production |
| `MCP_ALLOWED_HOSTS` | empty | Exact comma-separated hosts; no external MCP registration by default |
| `MCP_ALLOWED_AUDIENCES` | empty | Exact comma-separated audiences; no external MCP registration by default |
| `LLM_TOKENS_PER_MINUTE_PER_CALLER` | `0` | Optional per-caller APIM `llm-token-limit`; `0` disables it. The prepaid ledger always applies |

APIM supports Developer, BasicV2, StandardV2 and PremiumV2 as allowed inputs;
availability/capacity are not guaranteed without a real target. PostgreSQL has
seven-day local backups, no zone HA, no geo-redundant backup and no automatic
storage growth. Do not treat these development defaults as production sizing.
The app and job each request 0.5 vCPU/1 GiB; Log Analytics retains 30 days.
The replica environment values are bounded string parameters converted with
`int()` inside the service template: azd 1.30.0's revision helper substitutes
JSON strings directly, unlike the foundation provisioning parameter pipeline.

**Costs are not estimated or approved.** Billable components include APIM
units, PostgreSQL compute/storage/backups, ACR storage/build tasks, ACA replicas
and job executions, private DNS queries/zones, log ingestion/retention, network
data, and ACA-managed public IP/load-balancer resources in an additional managed
resource group. Select the real subscription/region, obtain prices and review
the deployment/what-if before provisioning. Creating the foundation alone
starts charges for standing resources.

## Database and identity boundaries

The new VNet uses `10.42.0.0/16`, with an ACA-delegated `10.42.0.0/23` subnet
and PostgreSQL-delegated `10.42.2.0/24` subnet. This is a **workload-profile
environment with Consumption**, not the older consumption-only networking
model. No peering or customer route table is created. Review address overlap
before connecting this isolated development VNet to other networks.

PostgreSQL uses a linked `private-<token>.postgres.database.azure.com` private
DNS zone, a delegated subnet, and `publicNetworkAccess: Disabled`.
There are **no database firewall rules**, local-password inputs, password
outputs or local database administrator. The PostgreSQL NSG accepts 5432 only
from ACA and its own database subnet before denying other VNet inbound traffic.
Default outbound rules retain required Entra and Storage connectivity.

The database Entra administrator is **only the migration UAMI**, registered as
`ServicePrincipal` using its object ID and display name. The runtime UAMI is
not an administrator and cannot migrate schemas. Bootstrap creates/maps
`gateway_app` to the runtime object ID and grants application-data permissions.
Its URI is `postgresql://gateway_app@<server-FQDN>:5432/gateway?sslmode=verify-full`.
No token is embedded or persisted; the app obtains connection tokens using
its runtime identity. The job has the separate migration identity and no
Foundry/APIM management roles.

Both identities receive ACR **AcrPull only**, at registry scope. ACR has admin
and anonymous access off, registry RBAC rather than repository ABAC, and ARM
audience token support enabled for ACA identity-based pulls. ACR, APIM and ACA
HTTPS ingress are public to support remote build/browser/APIM access; only
database connectivity is private. Public ACA ingress does not bypass the
application's user-token and APIM-proof authorization checks.

The existing Foundry module grants runtime account-scoped inference and a
custom deployment read/write role, not account creation/deletion or key reads.
The APIM runtime role permits only API registration/read/policy operations.
APIM's own system identity acquires the separate proof-API token; the Entra
`Gateway.Invoke` app-role assignment is performed by setup, **not Bicep**.
No runtime identity receives Graph permissions.

## AVM selection and explicit resource decisions

Selection was reviewed in order: AVM **azd patterns**, resource modules, then
small explicit resources. The official azd revision workflow explicitly
supports a direct service resource and an image parameter at deployment time.

Pinned public modules:

- `avm/res/container-registry/registry:0.13.1`
- `avm/res/managed-identity/user-assigned-identity:0.6.0` (both identities)

`avm/ptn/azd/container-app-upsert` and `acr-container-app` are not used: this
profile must not create an app in foundation or seed a placeholder revision.
`container-apps-stack` was checked, but its reviewed interface does not expose
the ACR ARM-audience authentication and registry-RBAC controls used here.
Individual ACR/identity resource modules let those constraints remain explicit.

Other resource modules (including PostgreSQL, VNet, managed environment and
APIM) were reviewed. Direct resources keep this security-sensitive profile's
exact fixed database/network and authorization contract visible in the compiled
template: no optional password branch, firewall fallback, automatic bootstrap
or implicit roles. The PostgreSQL AVM module exposes local administrator/password
and firewall inputs; this profile deliberately has none. Direct app/job resources
make image-before-release, distinct identities, bootstrap command and probes
auditable without upsert behavior. Small DNS/network/logging resources support
that same fixed topology without unrelated optional deployments. Existing
APIM policies and custom Foundry roles are reused rather than copied or
broadened to module-default Contributor roles. AVM usage telemetry is disabled.

Official references checked for these decisions:

- [azd Container Apps revision and job workflows](https://learn.microsoft.com/azure/developer/azure-developer-cli/container-apps-workflows)
- [azd 1.30.0 native Publish/Deploy implementation](https://github.com/Azure/azure-dev/blob/azure-dev-cli_1.30.0/cli/azd/pkg/project/service_target_containerapp.go)
- [azd 1.30.0 deploymentHost and compileBicep helpers](https://github.com/Azure/azure-dev/blob/azure-dev-cli_1.30.0/cli/azd/pkg/project/service_target_dotnet_containerapp.go)
- [AVM pattern catalog](https://azure.github.io/Azure-Verified-Modules/indexes/bicep/bicep-pattern-modules/)
- [azd Container Apps stack interface](https://github.com/Azure/bicep-registry-modules/blob/main/avm/ptn/azd/container-apps-stack/main.bicep)
- [ACR resource module](https://github.com/Azure/bicep-registry-modules/tree/main/avm/res/container-registry/registry)
- [UAMI resource module](https://github.com/Azure/bicep-registry-modules/tree/main/avm/res/managed-identity/user-assigned-identity)
- [PostgreSQL resource module](https://github.com/Azure/bicep-registry-modules/tree/main/avm/res/db-for-postgre-sql/flexible-server)
- [PostgreSQL 2025-08-01 server schema](https://learn.microsoft.com/azure/templates/microsoft.dbforpostgresql/2025-08-01/flexibleservers)
- [PostgreSQL Entra administrator schema](https://learn.microsoft.com/azure/templates/microsoft.dbforpostgresql/2025-08-01/flexibleservers/administrators)
- [PostgreSQL private networking and DNS](https://learn.microsoft.com/azure/postgresql/network/concepts-networking-private)
- [ACA delegated subnet requirements and managed-resource costs](https://learn.microsoft.com/azure/container-apps/custom-virtual-networks)
- [ACA identity-based image pull prerequisites](https://learn.microsoft.com/azure/container-apps/managed-identity-image-pull)
- [Azure resource naming rules](https://learn.microsoft.com/azure/azure-resource-manager/management/resource-name-rules)

## Offline validation

Deployment prerequisites are azd, Bicep CLI, Node.js 24 and PowerShell 7.
Use a single azd login for the deployment workflow, always naming the tenant
(`azd auth login --tenant-id <TENANT_ID>`) and setting `AZURE_TENANT_ID` and
`AZURE_SUBSCRIPTION_ID` explicitly in the azd environment. Azure CLI login is
not required by the hooks; if you run optional `az` commands, use
`az login --tenant <TENANT_ID>` and `az account set --subscription <SUBSCRIPTION_ID>`
first. With Bicep CLI available, from the repository root:

```powershell
# First-time public module download only (no Azure login or deployment).
bicep restore .\infra\azd\main.bicep
# Cached modules; compilation and contract tests never contact Azure.
.\scripts\Test-AzdInfrastructure.ps1
```

`Test-AzdInfrastructure.ps1 -Restore` combines those steps if public module
restore is desired. Default tests use `--no-restore`, compile every profile
Bicep file through stdout, and leave **no generated artifacts**. They inspect
compiled resources plus contract/auth/policy invariants. Bicep CLI 0.44.1 was
used during preparation; 0.48.1 was used for the v0.2.0 observability changes.

Compilation is not ARM what-if, SKU/quota validation, Graph consent, private
DNS resolution, RBAC propagation, a successful real migration, APIM policy
acceptance (MCP uses the existing preview API), actual FQDN/readiness or live
MCP/inference verification. Those remain deployment gates in a real approved
target. No Azure provisioning, authentication/token request, Entra mutation,
remote image build or database operation is performed by these offline checks.
