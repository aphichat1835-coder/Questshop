# Questshop requirement traceability

The Final Decision-Complete plan is authoritative when wording differs from the Technical Blueprint,
except for the later Owner decision recorded below: a Monitor-discovered Quest is private until
one Monitor background test passes.  This supersedes the earlier non-gating test wording.
This matrix separates implemented controls from evidence that can only be produced with production credentials.

| Requirement group | Primary implementation | Automated evidence | Live evidence still required |
|---|---|---|---|
| Node 22 ESM, first-run setup, PostgreSQL pools/TLS/time | `src/config`, `scripts/setup.js`, `scripts/setup-verify.js`, `scripts/setup-preflight.js`, `scripts/verify-postgres-roles.js`, `src/db`, migrations 0001–0024 | syntax/lint/setup idempotency, runtime/deployment credential boundary, Aiven-managed migration policy audit and migration checksum tests | durable split secret-manager mount plus managed PostgreSQL role and CA validation |
| State machines, CAS, correlation, audit | domain `states.js`, `state_transitions`, durable interaction sessions and domain services | state/unit and integration tests; CI refuses a missing PostgreSQL test database rather than skipping contract cases | production trace sampling |
| Wallet, immutable ledger, reservation/capture/release/refund | `domain/wallet`, secure retention function, `refunds` | concurrent debit, 3/2 settlement, idempotent captured-item refund, checkpoint tests | Owner pre-launch compensation sign-off |
| TrueMoney Direct, receiver snapshot, HMAC, ambiguity | `adapters/truemoney`, payment worker/services | URL allowlist, pinned-schema, post-send ambiguity, duplicate-voucher and crash-credit tests | real success/ambiguous/schema fixtures |
| Promotion and pricing precedence | pricing/promotion resolvers and Admin config services | money/unit and PostgreSQL constraints | Owner price/promotion UAT |
| Catalog discovery, metadata, sale/test axes | `domain/catalog`, discovery/test workers, `quest_test_batches`, migration `0024` | Monitor-gate integration test: 3 attempts per Monitor, first pass stops, failures create private override, contract hash prevents an old pass/override from reopening a changed Quest, and a Quest Manual Review can retry/reseed a batch; customer-account admission and customer `quest-new` announcement test | live Quest API metadata drift and Monitor test UAT |
| Monitor Token control and health | `domain/admin/monitor-service`, Admin router, migrations `0018_monitor_health.sql` and `0022_monitor_state_version.sql` | Monitor add always writes `SCAN` + `TEST`; explicit enable/disable commands use expected state/version, and read-only health checks preserve manual `DISABLED` while recording invalid Token health | Owner checks the panel against real Monitor accounts |
| Checkout, quote revalidation, account lock | `domain/checkout`, interaction router | signed-preflight, current-contract revalidation, large-order/account uniqueness and idempotent simultaneous-confirm tests | mobile Discord UAT |
| Fair queue, lazy jobs, dynamic expiry | runner/catalog expiry services | fair queue, lazy materialization, explicit `WAITING_RATE_LIMIT` recovery and crash-state checkpoint tests | runtime p95 calibration |
| Runner checkpoints, lease/fencing, no claim | runner service, Quest executor registry | crash/fencing, pinned-contract revalidation, separate controlled-retry intent, stale Manual-Review denial, contract-failure containment, restart-recovery transition audit, atomic terminal settlement, recovery Capture with durable provenance, ambiguous completion keeps funds Reserved, and no-claim source scan | live video/desktop Quest UAT |
| Quest API timeout/recovery/rate limits | API client, shared persistent coordinator and migration `0023_quest_api_rate_limit_blocks.sql` | timeout classification before/after dispatch, endpoint-specific 403, CAPTCHA-safe heartbeat fallback, shared-coordinator and bounded durable-cooldown cleanup tests | live Discord 429/timeout/restart behaviour |
| Outbox, coalescing, Discord errors, DLQ | outbox services/workers/renderers | event/projection fencing plus state-version CAS, nonce reconciliation, DLQ replay/discard, 403/404/429 fault-contract tests and one-attempt best-effort Order DM | real Discord fault UAT |
| Customer/admin Discord surfaces | setup/router/renderers, durable `PENDING_BIND` sessions | route acknowledgement/error tests, exact rendered-message binding, legacy-component response, payload bounds, setup nonce/reconciliation tests | production guild layout, mobile rendering and full panel UAT |
| Manual review and money authority | reviews service/Admin panel | atomic ambiguous-credit and Quest-test retry/reseed tests | Owner review workflow UAT |
| Automatic daily top-up lock and Admin audit | `topup_daily_locks`, wallet/payment/Admin services | expiry, limit and audit paths | Discord Administrator access UAT |
| Surface setup permissions | Discord startup/surface setup/outbox workers, migration `0020_remove_surface_expected_permissions.sql` | startup refuses a Bot without Administrator; no persisted drift snapshot or human channel-visibility check; Owner configures private backoffice channels | production channel-layout setup test |
| Health, metrics, SLO alerts, gates | bootstrap health and alert worker | financial invariant and scheduler-lag alerts; authenticated `/statusz` HTTP contract; syntax/lint coverage for duplicate-credit and latency-SLO paths | external alert delivery/monthly uptime observation |
| Aiven backup policy, retention, keys | backup policy config, deployment audit, retention/key worker | Aiven mode skips local backup worker/alerts/pg tools and records the provider policy; confirmed checkout-session/credential cleanup and 500-row `SKIP LOCKED` retention batch | Aiven Console backup/recovery evidence; no Questshop restore-drill claim |
| Deployment, rollback, CI, load | Dockerfile, workflow, scripts, UAT docs | deployment-only migration with required production pre-backup; CI LCOV artifact, Docker build and disposable 200-user/100-order load test | same-SHA deploy/rollback rehearsal |

Completion labels:

- `implemented-but-unverified`: source and automated controls pass, but one or more live boundaries above are missing.
- `done`: all automated evidence and every live boundary pass on the exact same Git SHA.
- `production-ready` is forbidden before concurrent money tests, payment crash tests, restore drill and Owner UAT pass.

The requirement-by-requirement audit for the plans is maintained in
[`completion-audit.md`](./completion-audit.md).  It is deliberately an evidence record, not a
claim that a source-only checkout has passed Discord, TrueMoney, S3, managed PostgreSQL or Owner UAT.
