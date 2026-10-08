# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/); the project is pre-1.0, so minor
versions may include breaking changes, which are called out explicitly.

## [0.3.0] - 2026-10-08

### Documentation

- **Docs: rewrote for external audiences; removed internal terminology.** The
  documentation now addresses readers directly and contains no internal
  tooling or process references.
- **New documentation layout** under `docs/` with a standard numbering:
  `00-reproduce-this-demo`, `01-architecture`, `02-prerequisites`,
  `03-deployment` (azd fast path), `03b-manual-deployment`, `04-testing`,
  `05-troubleshooting`, `06-budgets-and-ledger`, `07-identity-and-security`,
  `08-observability-and-token-metrics`, `09-mcp-governance`,
  `10-api-reference`, `11-azd-integration-contract` and
  `12-configuration-reference`. The previous `docs/API.md`, `AZD-CONTRACT.md`,
  `BUDGETS.md`, `DEPLOYMENT.md`, `SECURITY.md`, `SOURCES.md` and `TESTING.md`,
  and the operator references in `infra/README.md` and `infra/azd/README.md`,
  were folded into the new pages without dropping content. README carries a
  "Moved documents" table mapping every old location to its new one;
  `infra/README.md` and `infra/azd/README.md` are now short folder guides.
- **New content:** a one-page reproduce-this-demo orchestrator, a
  troubleshooting guide keyed by the stable hook and API error codes, a
  regions/cost/pre-flight prerequisites page, a configuration reference listing
  every azd variable, output, manual parameter, runtime variable and recipe,
  custom-metric cardinality guidance and a starting KQL query for chargeback.
- **16 draw.io diagrams with PNG exports**, built from official Azure
  Architecture Icons (V24) embedded in the files: reference architecture,
  service catalog, budget admission flow (reserve → call → settle/hold),
  identity flows (delegated user vs. app-only agent), token-metric telemetry,
  MCP governance, azd deployment flow, azd release gate, manual deployment
  steps, deployment profiles, configuration flow, API surface, testing matrix,
  troubleshooting decision tree, prerequisites map and the offline demo story.
- Local product icons (`docs/assets/icons/`, with attribution) and SVG status
  badges (`docs/assets/badges/`); no external badge service.

### Added

- `scripts/lint_doc_visuals.py` (documentation visual lint; run with
  `--strict`), `scripts/export_diagrams.py` (draw.io → PNG export and
  `--check` for stale PNGs), `scripts/make_badges.py` (local SVG badges) and
  `tests/test_doc_visuals.py`. CI gains a `docs` job that runs the strict lint.

### Changed

- `scripts/Test-AzdInfrastructure.ps1` reads the output contract from
  `docs/11-azd-integration-contract.md`; `Deploy-Gateway.ps1` points to
  `docs/03b-manual-deployment.md`.
- Removed `.azure/deployment-plan.md` from version control; it was a local
  tool artifact. `.azure/` is now fully gitignored.
- Version 0.3.0. No application, policy or infrastructure behavior changed.

### Verification

- `npm ci`; `npm run typecheck`; `npm test` (API 75, portal 66, azd hooks 19);
  loopback smoke; Bicep compilation; `Test-Infrastructure.ps1`;
  `Test-AzdInfrastructure.ps1 -Restore`; `npm run validate:azd`;
  `lint_doc_visuals.py --strict` (0 errors); diagram validation and
  `export_diagrams.py --check` (0 stale). Still not live-deployed.
## [0.2.0] - 2026-10-07

### Added

- **LLM token metrics for chargeback.** The APIM inference route emits
  `llm-emit-token-metric` custom metrics (namespace `ai-gateway`) with the
  dimensions *API ID, Team ID, Model, Client App ID, Caller Type*. Dimension
  values are bounded identifiers validated by pattern; no prompt or completion
  content is used.
- **Application Insights.** New `infra/modules/observability.bicep` provisions
  workspace-based Application Insights (local auth disabled, custom metrics
  with dimensions), grants APIM's system identity *Monitoring Metrics
  Publisher*, and creates an APIM logger that authenticates with that managed
  identity. The inference API gets an Application Insights diagnostic with
  `metrics: true` and no header, body, LLM message or client-IP logging.
  Wired into both the azd profile (on its existing Log Analytics workspace) and
  the manual profile (new dedicated Log Analytics workspace, configurable
  `logRetentionInDays`).
- **Optional `llm-token-limit`.** `llmTokensPerMinutePerCaller` (azd:
  `LLM_TOKENS_PER_MINUTE_PER_CALLER`, default `0` = off) adds a per-caller
  tokens-per-minute throttle keyed by the validated token `oid`, counting
  actual usage only. It complements the prepaid USD ledger and never replaces it.
- **App-only callers (agents, managed identities, service principals).**
  - New Application-only app role `Gateway.Agent` on the user API (created by
    azd setup in `auto` mode and saved as `GATEWAY_AGENT_ROLE_ID`; optional for
    `existing` registrations). It is never assigned automatically.
  - APIM inference, read-only tools, and external MCP policies admit
    `Gateway.Agent`. The external MCP policy generator now accepts either a
    delegated user (gateway scope + user role) or an app-only caller with
    `Gateway.Agent`.
  - The API accepts app-only tokens (no `scp`, `Gateway.Agent` role, client ID
    from `azp`/`appid`, not APIM's own identity) on the data plane only
    (`/openai/v1/chat/completions`, `/mcp-tools/*`). Portal/admin routes remain
    delegated-user-only, and `Gateway.Agent` is stripped from delegated tokens.
  - Teams have a new `applications` list (service-principal object IDs),
    disjoint from user `principals`; omitting it on update preserves the stored
    list. The portal team form gains **Application identity object IDs**.
  - Ledger and audit attribution: reservations record `actor_type`
    (`user`/`app`) and `client_app_id`; audit rows record `actor_type`
    (`user`/`app`/`system`). Usage and audit APIs and the Activity page show the
    caller type.
- **Offline agent demo.** The loopback demo seeds a clearly fake agent identity
  registered to `demo-engineering`. Use `X-Demo-Caller: app` on data-plane
  routes or the playground's **Call as the demo agent identity** toggle
  (`simulateAgent`, rejected outside the demo with `DEMO_ONLY`).
- Tests for app-only admission with/without the role, unmapped teams, missing
  APIM proof, portal-route rejection, budget enforcement and ledger/audit
  attribution for app callers, team registration rules, the demo agent, the
  external MCP policy, the Gateway.Agent Entra setup, the new APIM policy
  elements and the observability resources. The loopback smoke test now
  includes an app-only scenario.

### Changed

- **Database schema migration v2** (additive): new `reservations.actor_type`
  (default `user`), `reservations.client_app_id`, and `audit.actor_type`
  columns. Run the migration (azd does this automatically in its gated
  predeploy job) before serving traffic with v0.2.0; pre-existing audit rows
  report `actorType: "unknown"`.
- The inference route now buffers its bounded (2 MB), non-streaming response
  (`buffer-response="true"`) so the token-metric policy can read `usage`. MCP
  routes still never buffer. No retries were added.
- **Public npm registry.** `package-lock.json` now resolves from
  `https://registry.npmjs.org/`; the project `.npmrc` that pinned a private feed
  was removed, the Dockerfile `NPM_CONFIG_REGISTRY` build argument defaults to
  the public registry, and `azure.yaml` no longer passes a private-feed build
  argument. Mirrors work per user (`npm config set registry …`) or per build
  (`--build-arg NPM_CONFIG_REGISTRY=…`) because npm rewrites the lockfile host.
- **Tenant-explicit sign-in.** Documentation and hook messages use
  `azd auth login --tenant-id <TENANT_ID>`, explicit `AZURE_TENANT_ID` /
  `AZURE_SUBSCRIPTION_ID` azd values, and `az login --tenant <TENANT_ID>` plus
  `az account set --subscription <SUBSCRIPTION_ID>` for optional `az` commands.

### Deployment notes

- Not yet validated against a live Azure deployment. Verify after deploying:
  APIM accepts the policy expressions, token metrics appear in Application
  Insights, and an app-only caller with `Gateway.Agent` can call inference
  through APIM.

## [0.1.0]

- Initial release: React/TypeScript portal, governance API with a
  transactional USD-microdollar budget ledger, APIM AI and MCP gateway policies,
  azd and manual Bicep profiles, and a loopback-only simulated demo.
