# azd integration contract

The azd profile is additive: `infra/azd` is the subscription-scoped entry point.
The existing `infra/main.bicep` and manual PowerShell deployment remain advanced
bring-your-own-resource alternatives.

## Deployment sequence

1. `preup` verifies tools, selected tenant/subscription/region and existing
   Foundry inputs, then creates or validates owned Entra registrations.
   `preprovision` repeats read-only validation; provision/preview hooks never
   create or change Entra registrations.
2. Provision creates a resource group, ACR, APIM, Container Apps environment,
   private PostgreSQL 17/network/DNS, Log Analytics, workspace-based Application
   Insights with an APIM managed-identity logger and inference diagnostics
   (LLM token metrics), runtime and migration identities, and narrowly scoped
   role assignments. No application placeholder is published.
3. azd builds and publishes the application remotely through ACR using the
   existing Dockerfile and the public npm registry (or a build-argument mirror).
4. Service predeploy configures APIM's `Gateway.Invoke` application-role
   assignment and the SPA redirect URI, idempotently and failure-closed.
5. The service `predeploy` hook (after native azd publish) runs a manual Container Apps migration job
   with that exact published image, waits for success, and blocks app release
   on failure. The job has a separate PostgreSQL administrator identity.
6. azd revision-based deployment applies the application Bicep with its actual
   image. Runtime has only PostgreSQL application-data permissions; startup
   verifies the schema, never migrates production.
7. Postdeploy checks actual application readiness and identity/endpoint setup.
   Command success must not imply unperformed live MCP/inference tests.

Ordering was verified in azd 1.30.0's `service_manager.go`: Publish completes
before the service Deploy event. Publish saves `SERVICE_GATEWAY_IMAGE_NAME`;
the hook resolves its registry manifest to a digest and saves
`GATEWAY_DEPLOY_IMAGE` only after that exact image's job succeeds. The revision
parameter file consumes that digest. Direct `azd deploy` runs the same gate,
including `--from-package`; unapproved registries are rejected. No hook calls
`azd deploy` recursively.

## Environment inputs

Required at actual deployment:

- `AZURE_ENV_NAME`, `AZURE_SUBSCRIPTION_ID`, `AZURE_LOCATION`, `AZURE_TENANT_ID`.
- `FOUNDRY_RESOURCE_GROUP`, `FOUNDRY_ACCOUNT_NAME`, `FOUNDRY_ENDPOINT`.
- APIM publisher contact; setup may prompt or require explicit values.

Created or validated by setup:

- `ENTRA_SPA_CLIENT_ID`, `ENTRA_API_AUDIENCE`, `ENTRA_API_SCOPE`,
  `GATEWAY_API_AUDIENCE`.
- Corresponding Graph application/object IDs may be saved as nonsecret azd
  environment values to support safe resume. Never persist access tokens.

Optional development defaults must be explicit, validated, and documented:
APIM Developer (evaluation, no production SLA), PostgreSQL Burstable,
empty external MCP allowlists, `LLM_TOKENS_PER_MINUTE_PER_CALLER=0` (optional
`llm-token-limit` off). Foundry remains an existing account.

Setup also saves `GATEWAY_AGENT_ROLE_ID` (the user API's Application-only
`Gateway.Agent` app role) when that role exists. It is never assigned
automatically; operators assign it per app-only caller.

## Shared infrastructure outputs

Use these exact names or coordinate a change before consumers are written:

| Output | Meaning |
| --- | --- |
| `AZURE_RESOURCE_GROUP` | New resource group |
| `AZURE_CONTAINER_REGISTRY_NAME` | ACR name |
| `AZURE_CONTAINER_REGISTRY_ENDPOINT` | ACR login server |
| `AZURE_CONTAINER_APPS_ENVIRONMENT_NAME` | ACA environment name |
| `AZURE_CONTAINER_APPS_ENVIRONMENT_ID` | ACA environment resource ID |
| `AZURE_CONTAINER_APP_NAME` | Deterministic gateway app name |
| `SERVICE_GATEWAY_RESOURCE_ID` | Gateway resource ID, even before first release |
| `GATEWAY_URL` | Expected application HTTPS URL using environment default domain |
| `APIM_SERVICE_NAME`, `APIM_RESOURCE_GROUP`, `APIM_GATEWAY_URL` | APIM coordinates |
| `APIM_PRINCIPAL_ID` | APIM system-assigned identity object ID |
| `AZURE_CLIENT_ID` | Runtime UAMI client ID |
| `RUNTIME_IDENTITY_ID`, `RUNTIME_PRINCIPAL_ID` | Runtime identity resource/object ID |
| `MIGRATION_IDENTITY_ID`, `MIGRATION_CLIENT_ID` | Migration UAMI resource/client ID |
| `MIGRATION_PRINCIPAL_ID`, `MIGRATION_PRINCIPAL_NAME` | PG Entra admin object/display name |
| `POSTGRES_HOST`, `POSTGRES_DATABASE` | Server FQDN and application database |
| `POSTGRES_APP_ROLE` | Runtime database role, `gateway_app` |
| `DATABASE_URL` | Passwordless runtime URI with `sslmode=verify-full` |
| `DATABASE_AUTH` | `entra` |
| `MIGRATION_JOB_NAME` | Manual job name for bootstrap and migrations |
| `AZURE_LOG_ANALYTICS_WORKSPACE_ID` | Shared Log Analytics workspace resource ID |
| `APPLICATIONINSIGHTS_NAME`, `APPLICATIONINSIGHTS_ID` | Workspace-based Application Insights receiving APIM telemetry and LLM token metrics |

## Application database authentication

Keep existing `DATABASE_URL` password authentication behavior for the manual
profile and demo. Add `DATABASE_AUTH=entra` for azd. In this mode a
`ManagedIdentityCredential` obtains an Azure PostgreSQL access token per new
connection (never embed a token in the URI or log it). No credential fallback.

The migration image entry point is
`node apps/api/dist/bootstrap.js`. It consumes:

- `AZURE_CLIENT_ID`: migration identity, not runtime identity.
- `POSTGRES_HOST`, `POSTGRES_DATABASE`, `POSTGRES_APP_ROLE`.
- `MIGRATION_PRINCIPAL_NAME`: administrator login name.
- `RUNTIME_PRINCIPAL_ID`: application identity object ID.

It maps `gateway_app` to the runtime service principal using supported
`pgaadauth` functions, refuses an existing role mapped to another principal,
runs idempotent migrations, then grants only required table permissions.
Audit is append/read; migration metadata is read-only for the runtime.
The runtime must not be the PostgreSQL administrator.

## Security and execution boundaries

- PostgreSQL is Entra-only and privately reachable from the ACA environment/job.
- No all-Azure or internet-wide database firewall rule and no local migration
  against a private database.
- The lockfile resolves from the public npm registry. A mirror is selected per
  user (`npm config set registry`) or per image build (`NPM_CONFIG_REGISTRY`
  build argument); npm rewrites the lockfile host to the configured registry.
- The default path requests native ACR remote builds and never installs or
  invokes Docker itself. azd 1.30 may explicitly fall back to an available local
  engine after a remote-build failure.
- No deployment, Entra mutation, token acquisition, cloud build, database change,
  or role assignment is executed during preparation/validation in this session.
- Offline hook tests inject/mock Azure/Graph calls and verify failure paths.
- Owned Entra resources are identifiable and reused safely; externally supplied
  registrations are validated, not silently repurposed or deleted.
- Admin consent/permission errors stop with clear operator actions. Do not
  grant broad Graph permissions to runtime identities.
