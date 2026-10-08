# Azure deployment plan

## Status

Ready for Validation. The user approved making azd the primary deployment path and
automating supporting resources and setup. This approval is for preparation
and local validation only, not Azure provisioning.

## Scope

- Keep the existing React/TypeScript application and budget/security behavior.
- Keep Foundry as an existing, operator-selected account.
- Provision APIM, application hosting, ACR, PostgreSQL and required networking
  and identities through the azd workflow.
- Automate Entra registration/configuration when permitted. Fail with actionable
  instructions when tenant authorization or consent requires an administrator.
- Use a configurable npm registry (public by default); do not require a local Docker daemon.
- Keep production schema changes explicit and ordered before serving traffic.
- Retain the existing manual deployment path as a documented advanced fallback.

## Azure context

Subscription, region, environment name, Foundry account and production cost
estimate are deferred. Resolve and confirm these before any actual deployment.
Do not use the current tenant-only CLI context as a subscription.

## Verified design decisions

- Recipe: AZD/Bicep, modifying the existing project without template replacement.
- Root `azure.yaml` uses `infra/azd/main.bicep` for subscription provisioning and
  `gateway.bicep` for native revision-based application deployment.
- Installed azd 1.30.0 source confirms Publish precedes service predeploy;
  `SERVICE_GATEWAY_IMAGE_NAME` is saved before the migration hook and environment
  changes are reloaded after hooks.
- Native ACR remote build uses the existing Dockerfile and npm registry setting. The predeploy
  gate resolves a registry digest, runs that exact image in a migration job,
  and sets `GATEWAY_DEPLOY_IMAGE` only after successful, verified execution.
- Private PostgreSQL 17 is Entra-only. A separate migration identity administers
  it; runtime has a mapped non-admin role and data-only grants. Production
  startup verifies schema rather than performing migrations.
- Entra automation is idempotent and environment-owned, with read-only
  validation mode for externally supplied registrations. Permission failures
  stop rather than weaken controls. No client secrets or persisted access tokens.
- Tenant mutation occurs in `preup` and service predeploy, never in
  preprovision/preview hooks. A first provision preview requires separately
  approved prior identity setup or existing registrations.
- Existing manual infrastructure remains a separate advanced fallback.

## Resource inventory and live prerequisites

The profile creates one resource group, ACR, APIM, ACA environment, PostgreSQL
server/database, VNet with separate ACA/PG subnets, private DNS/link, logging
workspace, two UAMIs, scoped role definitions/assignments, a manual migration
job and one application service. Foundry remains existing. Three Entra app
registrations and API service principals are created or validated.

Evaluation defaults: APIM Developer, PostgreSQL Burstable Standard_B1ms / 32 GiB,
small Consumption app/job. Review production availability/sizing separately.

**Quota, regional capacity and cost validation: blocked/deferred, not passed.**
There is no approved real subscription/region to query. These remain deployment
approval prerequisites; no invented quota figures or dollar estimates are used.

## References

- `https://learn.microsoft.com/azure/developer/azure-developer-cli/container-apps-workflows`
- `https://learn.microsoft.com/azure/developer/azure-developer-cli/azd-extensibility`
- `https://github.com/Azure/azure-dev/tree/azure-dev-cli_1.30.0/cli/azd/pkg/project`
- `https://learn.microsoft.com/azure/postgresql/security/security-manage-entra-users`
- `https://learn.microsoft.com/graph/api/serviceprincipal-list-approleassignedto`

AVM selection and pinned module versions are documented in `infra/azd/README.md`.
Azure MCP/quota tools are not configured here; no additional MCP is installed
and no Azure login/subscription is silently selected during preparation.

## Work

1. [x] Verify current azd lifecycle and inspect existing deployment artifacts.
2. [x] Finalize integration contract and resource topology (`docs/AZD-CONTRACT.md`).
3. [x] Implement infrastructure and lifecycle hooks in parallel.
4. [x] Add optional managed-identity database authentication and job bootstrap.
5. [x] Update deployment documentation and add offline regression checks.
6. [x] Complete application/infrastructure/azd validation without cloud mutations.
7. [x] Invoke azure-validate; preserve blocked live prerequisites.

## azure-validate recipe checklist

- [ ] All validation checks pass (live checks are intentionally blocked).
  - [x] AZD installation: installed 1.30.0.
  - [x] Schema validation: full official 1.30.0 JSON Schema plus 14 referenced
    schemas validated locally with existing Python YAML/Ajv libraries.
  - [ ] Environment setup: local validation environment exists, but deployment
    target configuration was explicitly deferred by the user.
  - [ ] Authentication check: deferred; no Azure/Graph token was acquired.
  - [ ] Subscription/location check: no approved real target.
  - [x] Aspire pre-provisioning checks: not applicable (Node/React).
  - [ ] Provision preview: deferred pending an approved target and identity setup.
  - [x] Build verification: API and portal production builds passed.
  - [x] Docker build context: root Dockerfile/lockfile and source paths verified;
    local data, credentials and azd environment state excluded.
  - [x] Package validation: native `azd package gateway --no-prompt` succeeded
    without local Docker; image build/publish remains deferred to ACR.
  - [ ] Azure Policy validation: deferred with subscription/region.
  - [x] Aspire post-provisioning checks: not applicable.

The official validation workflow is paused at recipe validation, not marked
complete. **Plan status must not become Validated until live checks pass.**

## Offline validation proof

Recorded September 19, 2026, 03:34 UTC. No provisioning, Azure/Graph credential
acquisition, cloud build, Entra mutation or live database operation occurred.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed API and portal strict TypeScript checks |
| `npm run build` | Passed API and production portal build |
| `npm test` | Passed 68 API, 62 portal and 17 mocked azd lifecycle tests |
| `npm run validate:azd` | Passed all three azd entry-point compilations and release-gate checks |
| `azd hooks run prepackage --no-prompt` | Actual azd 1.30.0 loaded azure.yaml and ran its offline service hook successfully |
| Official azure.yaml JSON Schema validation (Python YAML + Ajv 2019, existing libraries) | Passed full version-pinned schema and its referenced schemas; no Azure calls |
| `azd package gateway --no-prompt` | Passed native packaging without Docker; no image built because remote build occurs at publish |
| `scripts/Test-AzdInfrastructure.ps1` | 375 checks passed, including five Bicep compilations |
| `scripts/Test-Infrastructure.ps1` | Manual-profile regression checks passed |
| `npm audit --audit-level=moderate` | No reported vulnerabilities |
| `npm run test:smoke` | Built app served locally on isolated loopback port; configured-budget and portal smoke passed |

Live Azure target, Entra authorization/consent, quotas/costs, real ACR build,
PostgreSQL identity/private connectivity and deployed MCP/inference validation
are blocked pending an approved target. Offline success is not deployment proof.

## Deployment gates

No azd provisioning, deployment, remote image build, role assignment, Entra
mutation or database change is authorized during preparation. Before deployment,
review the real Azure target, cost, permissions, network exposure and what-if.
