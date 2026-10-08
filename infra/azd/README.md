# azd infrastructure profile

The subscription-scoped templates behind `azd up`: `main.bicep` (foundation), `gateway.bicep` (application revision) and `migration-job.bicep` (release-gating migration job), with their parameter files and `modules/`.

- How to deploy: [docs/03-deployment.md](../../docs/03-deployment.md)
- The engineering contract (sequence, release gate, outputs, database identity model, module selection, offline validation) that previously lived in this file: [docs/11-azd-integration-contract.md](../../docs/11-azd-integration-contract.md)
- Every environment variable and default: [docs/12-configuration-reference.md](../../docs/12-configuration-reference.md)
