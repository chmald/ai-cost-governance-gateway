# Strict configured-price budgets

## Units and invariant

The API uses integer USD microdollars: `$1 = 1,000,000` microdollars.
Token prices are microdollars **per million tokens**, not per token.
Arithmetic rounds charges up and uses integer intermediates to avoid
floating-point undercharging. JSON amounts must remain safe integers.

For a team and a UTC calendar month, admission requires:

```text
settled spend + all outstanding reservations + new maximum charge
    <= configured monthly budget
```

The database serializes admission against the shared budget row. Every
replica must use the same PostgreSQL database. A local process mutex is not
sufficient for production; the embedded demo database is single-process.

Each reservation captures its original month, model, caller (user or app-only
application, plus the client application ID for apps), price snapshot,
and maximum charge. App-only callers (agents, managed identities, service
principals) spend the budget of the team that registers their object ID in
`applications`, under exactly the same admission rule; they have no separate
or unlimited allowance. Settlement occurs in that original month even if the
response arrives after midnight on the first of the following month.
Configuration changes cannot retroactively reprice an in-flight request.

## Why reserve a maximum instead of just estimated input tokens?

Output usage is not known until the provider returns. Checking current spend
and charging after a response permits simultaneous requests to exceed a cap.
Checking an eventually consistent analytics feed also leaves an overspend
window.

This implementation deliberately reserves against a conservative configured
context/output bound instead of predicting the likely answer length.
Administrators must verify the actual deployed model version, context window,
maximum output, and price validity. Understating those bounds invalidates a
maximum-charge claim. Do not copy example prices into production.

Only plain-text chat is initially supported. Extra billing surfaces are
rejected until the service has a defensible pricing bound for them.
No cache discount is assumed; charging uncached input rates is conservative.
No live Azure invoice reconciliation or currency conversion is implied.

## Failure semantics

| Event | Behavior |
| --- | --- |
| Insufficient available budget | Reject before Foundry is called. |
| Missing/expired pricing or disabled model | Reject; do not select a fallback model. |
| Unavailable database | Reject; do not fall back to memory or analytics. |
| Valid provider usage | Settle once using the reservation's original price snapshot. |
| Provider timeout, network error, or missing usage | Keep the reservation held; surface uncertainty. |
| Process crashes after reservation | Reservation remains held in durable storage. |
| Actual usage violates the configured bound | Fail closed and stop treating the model's configuration as safe. |
| Team budget is reduced below committed funds | Reject the update. |
| Month changes during inference | Settle the original month, not the current month. |

Inference is not automatically retried. An HTTP error does not prove that a
provider performed no billable work. A retry sent by a client is a new
admission with a new maximum reservation.

## Uncertain reservations

Do not delete old reservations or reset accumulated spend to make a dashboard
look correct. There is intentionally no automatic expiration/refund.
Reconciliation requires verified provider evidence and an audited operator
procedure. The initial portal does not offer a one-click refund for uncertain
charges; leaving money held is safer than guessing that it was not spent.

Database backups and recovery matter: restoring an old ledger can forget
already-billed work. Stop inference during recovery, reconcile provider usage,
and confirm balances before reopening admission.

## Complementary APIM token controls

APIM's `llm-emit-token-metric` reports prompt/completion/total tokens by API,
team, model, client application and caller type in Application Insights. Use it
for chargeback dashboards and anomaly alerts; it is not used for admission.

`llm-token-limit` is available as an **optional** per-caller tokens-per-minute
throttle (`llmTokensPerMinutePerCaller`, azd `LLM_TOKENS_PER_MINUTE_PER_CALLER`,
default `0` = off), keyed by the validated token `oid`. It counts actual response
usage (no prompt estimation) and smooths bursts. A throttled request is rejected
by APIM with 429 before the API is called, so no reservation is created. It is
per-gateway and approximate, and is never a substitute for the ledger: the USD
reservation above remains the authoritative spend control.

## Boundaries

The cap covers the configured inference-price ledger for traffic routed through
this application. It does not cover all Azure spend, external MCP tools,
capacity reservations/provisioned throughput, taxes, or traffic that bypasses
the gateway. Prevent bypass with Foundry RBAC, disabled local-key access, and
network isolation appropriate to your deployment. Keep separate Azure Cost
Management budgets and alerts for infrastructure/invoice visibility.
