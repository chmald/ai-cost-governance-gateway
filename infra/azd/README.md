# azd infrastructure profile

The subscription-scoped templates behind `azd up`: `main.bicep` (foundation), `gateway.bicep` (application revision) and `migration-job.bicep` (release-gating migration job), with their parameter files and `modules/`.

Set optional `APIM_LOCATION` to place only API Management in a separate region (for example `azd env set APIM_LOCATION southcentralus`). Unset/empty uses `AZURE_LOCATION` and preserves the original service name. `modules/apim.bicep` owns service creation; the foundation wires its outputs into policies, identity and observability. A region change creates a separate service and does not delete the original; see the deployment guide for replacement and cross-region considerations.

Set optional `CONTAINER_APPS_LOCATION` to place the Container Apps environment, application and migration job in another region while retaining private PostgreSQL and Foundry in `AZURE_LOCATION`. Different-region deployment adds `modules/container-apps-network.bicep`: a non-overlapping application VNet, bidirectional private peering and PostgreSQL private DNS linkage. Both release templates consume the resolved `AZURE_CONTAINER_APPS_LOCATION` output. Same-region defaults retain the shared-network design.

Foundry reuse is the backward-compatible default (`FOUNDRY_SETUP_MODE=reuse`). Opt-in `create` adds `modules/foundry.bicep`: an Entra-only AIServices S0 account/project in the same demo resource group and region, with public HTTPS egress from ACA. Hooks persist/validate the account name but never create Foundry; the shared least-privilege `../modules/foundry-access.bicep` runs after account creation. No initial model, hosted agents, or AI Gateway preview tier; portal-managed deployments/pricing and the existing ledger/APIM/private-database/migration gate remain unchanged.

- How to deploy: [docs/03-deployment.md](../../docs/03-deployment.md)
- The engineering contract (sequence, release gate, outputs, database identity model, module selection, offline validation) that previously lived in this file: [docs/11-azd-integration-contract.md](../../docs/11-azd-integration-contract.md)
- Every environment variable and default: [docs/12-configuration-reference.md](../../docs/12-configuration-reference.md)
