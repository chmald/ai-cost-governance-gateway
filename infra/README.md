# Infrastructure

This folder holds the Bicep templates and APIM policies for both deployment profiles.

| Path | What it is | Documentation |
|---|---|---|
| `azd/` | Primary profile used by `azd up` (subscription-scoped foundation, revision template, gated migration job) | [docs/03-deployment.md](../docs/03-deployment.md), [docs/11-azd-integration-contract.md](../docs/11-azd-integration-contract.md) |
| `main.bicep`, `main.parameters.example.json`, `registry.bicep` | Advanced bring-your-own-resource profile, deployed with `scripts/Deploy-Gateway.ps1` | [docs/03b-manual-deployment.md](../docs/03b-manual-deployment.md) |
| `modules/` | Shared modules: APIM gateway APIs and policies, Foundry access roles, observability | [docs/01-architecture.md](../docs/01-architecture.md) |
| `policies/` | APIM policy XML: inference, read-only tools, external MCP reference | [docs/07-identity-and-security.md](../docs/07-identity-and-security.md), [docs/09-mcp-governance.md](../docs/09-mcp-governance.md) |

Every parameter and default is listed in [docs/12-configuration-reference.md](../docs/12-configuration-reference.md). The operator reference that previously lived in this file moved to [docs/03b-manual-deployment.md](../docs/03b-manual-deployment.md).
