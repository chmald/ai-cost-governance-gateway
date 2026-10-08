# Design sources and provenance

Research date: September 18, 2026. This project is original code; no upstream
source files were copied. Dependencies retain their own licenses.

| Source | What informed this project | Deliberate simplification |
| --- | --- | --- |
| `https://github.com/Azure-Samples/ai-gateway-dev-portal` | Model/MCP catalog and developer-management workflows; source license reviewed as MIT. | A single focused portal with a server-side authority rather than broad browser ARM access, pasted tokens, and many separate analytics pages. |
| `https://github.com/Azure-Samples/AI-Gateway` | APIM as the shared model/tool gateway, Entra authentication, managed identity, and native MCP patterns. | A narrow supported inference surface with a durable pre-inference budget check instead of assembling many independent labs. |
| `https://github.com/Mehdi-Bl/foundry-budgets` | Requested by the project owner. | Returned HTTP 404 through public and authenticated GitHub access during research. Its code and license could not be reviewed; no assumptions or code reuse depend on it. |

A supplemental governance repository found during research was not used as
a source of implementation code. Periodically synchronizing spend from
analytics or downgrading to a cheaper model does not meet this project's
approved pre-admission budget requirement.

## Primary documentation

- APIM MCP resource management:
  `https://learn.microsoft.com/azure/api-management/manage-mcp-servers-rest-api`
- APIM MCP capabilities and limitations:
  `https://learn.microsoft.com/azure/api-management/mcp-server-overview`
- Securing MCP servers:
  `https://learn.microsoft.com/azure/api-management/secure-mcp-servers`
- APIM LLM token limits:
  `https://learn.microsoft.com/azure/api-management/llm-token-limit-policy`
- APIM token metrics (`llm-emit-token-metric`; `azure-openai-emit-token-metric`
  now redirects to it), dimensions and custom-metric limits:
  `https://learn.microsoft.com/azure/api-management/llm-emit-token-metric-policy`
- APIM Application Insights integration, managed-identity loggers and
  `"metrics": true` for custom metrics:
  `https://learn.microsoft.com/azure/api-management/api-management-howto-app-insights`
- Application Insights Microsoft Entra authentication:
  `https://learn.microsoft.com/azure/azure-monitor/app/azure-ad-authentication`
- Azure Monitor custom metric limits:
  `https://learn.microsoft.com/azure/azure-monitor/essentials/metrics-custom-overview`
- App-only access tokens and application permissions (app roles):
  `https://learn.microsoft.com/entra/identity-platform/access-tokens`
- Cost Management budgets:
  `https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets`
- Local embedded PostgreSQL:
  `https://pglite.dev/docs/`

MCP management uses a preview API version. Revalidate regional/SKU support and
the exact API resource schema before deploying; local Bicep compilation is not
an Azure deployment acceptance test.
