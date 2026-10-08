# Validation guide

The lockfile resolves from the public npm registry. Behind a corporate mirror,
set it once per user (`npm config set registry <mirror-url>`); npm rewrites the
lockfile's `registry.npmjs.org` host to the configured registry, so `npm ci`
needs no extra flags. Package integrity hashes are still verified.

```powershell
npm ci
npm run typecheck
npm test
npm run build
.\scripts\Test-Infrastructure.ps1
npm run validate:azd
.\scripts\Test-AzdInfrastructure.ps1
azd hooks run prepackage --no-prompt
```

The API suite covers reservations, concurrent admission, immutable prices,
idempotent settlement, month boundaries, uncertain outcomes, durable reopen,
quarantining invalid usage, roles and APIM proof, app-only (`Gateway.Agent`)
callers with team registration, budget enforcement and ledger/audit attribution,
the v2 attribution migration, scoped catalogs, stale pricing,
unsupported request shapes, deployment inventory drift, MCP management request
shapes, and target validation. Azure calls are mocked and no paid model is called.

The portal suite covers exact microdollar conversion, configuration/sign-in
states, role-aware navigation, form submissions (including application
identities), the demo-only agent playground toggle, explicit errors, and avoiding
automatic inference retries. A UI test is not proof that live Entra consent is
configured.

The default `npm test` also runs the offline azd hook suite. Use
`npm run test:azd` alone for focused deployment-hook checks. It mocks Azure/Graph
and verifies owned registration reuse, existing-registration read-only mode,
permission failures, exact-image migration gating, readiness, secret-safe
errors, and destructive-down refusal. Managed-identity database/bootstrap
tests are part of the API suite; they do not invoke the real Azure `pgaadauth`
extension or obtain tokens.

## Full local HTTP flow

Use a separate demo database, not a ledger you want to keep pristine:

```powershell
$env:GATEWAY_MODE = 'demo'
$env:HOST = '127.0.0.1'
$env:DATABASE_URL = 'pglite://data/http-smoke'
npm start
```

In a second terminal:

```powershell
npm run test:smoke
```

The smoke test refuses non-demo/non-loopback targets. It creates a unique team,
performs simulated inference, verifies settlement, exhausts the available cap,
checks that the next request is rejected without spending, rejects streaming,
creates a team that registers the fake demo agent, calls inference as an
app-only caller (`X-Demo-Caller: app`), verifies `actorType=app` settlement and
audit attribution, confirms the agent is refused on an unregistered team, and
loads the built portal. It intentionally leaves its records in this
**separate** database so persistence can be inspected across a restart.

Stop the server before deleting test data. PGlite uses a process lock: following
a forcibly killed process, confirm the recorded PID has stopped before removing
only that database's sibling `.gateway.lock` file. Do not release financial
reservations merely because a process stopped.

## Real PostgreSQL concurrency

The default local database is PGlite, which is single-process. Its tests cannot
establish PostgreSQL multi-replica behavior. This separate test uses independent
connection pools, concurrent reservations, and concurrent duplicate settlement:

```powershell
# Supply a connection to a dedicated test database through your environment.
npm run test:integration
```

`TEST_DATABASE_URL` is required; the command fails rather than claiming a
successful skipped test. The test creates a uniquely named schema and removes
only that schema afterward. Never point it at a production ledger.

The CI workflow supplies PostgreSQL 17 for this check. Running `npm test`
locally does not mean this integration test ran. The current workstation's
Docker daemon was unavailable during initial project creation, so real
PostgreSQL and the container build remain checks to run on a suitable runner.
The primary azd deployment path builds remotely in ACR; it does not require
that local Docker daemon.

## Infrastructure and deployment

`Test-Infrastructure.ps1` compiles Bicep, parses policies and PowerShell, and
checks authentication/routing invariants (including `Gateway.Agent`, the
`llm-emit-token-metric` dimensions, metadata-only diagnostics, Entra-only
Application Insights, and a public-registry lockfile) plus the deployment
helper's placeholder, wildcard, and secret-literal refusal. It makes no Azure
calls. Bicep compilation does not prove APIM accepts the policy expressions
or that token metrics arrive; verify both after a real deployment.

The CI workflow also builds the container. A successful local TypeScript build
does not prove the Linux container starts, and Bicep compilation does not prove
APIM accepts a policy or forwards native MCP identity correctly.

Before deployment, run the explicit checks in `docs/DEPLOYMENT.md` and
`infra/azd/README.md` against the approved Azure target. Verify live Entra sign-in,
APIM proof and MCP tool calls, backend RBAC, database TLS/network reachability,
model compatibility/pricing, and cross-replica budget behavior. These checks
are deliberately not presented as completed without a real deployment.
