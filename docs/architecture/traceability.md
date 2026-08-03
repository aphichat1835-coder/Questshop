# Questshop requirement traceability

The Final Decision-Complete plan is authoritative when wording differs from the Technical Blueprint,
except for the later Owner decision recorded below: a Monitor-discovered Quest is private until
one Monitor background test passes.  This supersedes the earlier non-gating test wording.
This matrix separates implemented controls from evidence that can only be produced with production credentials.

| Requirement group | Primary implementation | Automated evidence | Live evidence still required |
|---|---|---|---|
| Node 22 ESM, config, PostgreSQL pools/TLS/time | `src/config`, `src/db`, migrations 0001–0018 | syntax/lint/migration checksum tests | managed PostgreSQL role and CA validation |
| State machines, CAS, correlation, audit | domain `states.js`, `state_transitions`, durable interaction sessions and domain services | state/unit and integration tests | production trace sampling |
| Wallet, immutable ledger, reservation/capture/release/refund | `domain/wallet`, secure retention function, `refunds` | concurrent debit, 3/2 settlement, idempotent captured-item refund, checkpoint tests | Owner pre-launch compensation sign-off |
| TrueMoney Direct, receiver snapshot, HMAC, ambiguity | `adapters/truemoney`, payment worker/services | URL allowlist, pinned-schema, post-send ambiguity, duplicate-voucher and crash-credit tests | real success/ambiguous/schema fixtures |
| Promotion and pricing precedence | pricing/promotion resolvers and Admin config services | money/unit and PostgreSQL constraints | Owner price/promotion UAT |
| Catalog discovery, metadata, sale/test axes | `domain/catalog`, discovery/test workers, `quest_test_batches` | Monitor-gate integration test: 3 attempts per Monitor, first pass stops, failures create private override; customer-account admission and customer `quest-new` announcement test | live Quest API metadata drift and Monitor test UAT |
| Monitor Token control and health | `domain/admin/monitor-service`, Admin router, migration `0018_monitor_health.sql` | Monitor add always writes `SCAN` + `TEST`; read-only health check verifies decrypt/login/Quest-list access and quarantines invalid Token without exposing it | Owner checks the panel against real Monitor accounts |
| Checkout, quote revalidation, account lock | `domain/checkout`, interaction router | signed-preflight, large-order/account uniqueness and idempotent simultaneous-confirm tests | mobile Discord UAT |
| Fair queue, lazy jobs, dynamic expiry | runner/catalog expiry services | fair queue, lazy materialization, explicit `WAITING_RATE_LIMIT` recovery and crash-state checkpoint tests | runtime p95 calibration |
| Runner checkpoints, lease/fencing, no claim | runner service, Quest executor registry | crash/fencing, stale Manual-Review denial, contract-failure containment, restart-recovery transition audit and no-claim source scan | live video/desktop Quest UAT |
| Outbox, coalescing, Discord errors, DLQ | outbox services/workers/renderers | event/projection fencing plus state-version CAS, nonce reconciliation, DLQ replay/discard, 403/404/429 fault-contract tests and one-attempt best-effort Order DM | real Discord fault UAT |
| Customer/admin Discord surfaces | setup/router/renderers | session binding/security tests | production guild layout and permissions |
| Manual review and money authority | reviews service/Admin panel | atomic ambiguous-credit test | Owner review workflow UAT |
| Blocklist and Admin audit | blocklist/Admin services | database constraints and audit paths | Admin role UAT |
| Surface setup permissions | Discord Surface setup, migration `0020_remove_surface_expected_permissions.sql` | reject missing bot access/private-room exposure at install time; no persisted drift snapshot; 403 delivery incidents remain manual | production channel-layout setup test |
| Health, metrics, SLO alerts, gates | bootstrap health and alert worker | financial invariant and scheduler-lag alerts; syntax/lint coverage for duplicate-credit and latency-SLO paths | external alert delivery/monthly uptime observation |
| Backup, restore, retention, keys | S3 backup stream, drill script, retention/key worker | fake S3/pg_dump upload-verify-decrypt contract with versioned manifest, stream code checks and ledger retention test | real S3 backup and temporary-DB restore drill |
| Deployment, rollback, CI, load | Dockerfile, workflow, scripts, UAT docs | Docker build and fake load test | same-SHA deploy/rollback rehearsal |

Completion labels:

- `implemented-but-unverified`: source and automated controls pass, but one or more live boundaries above are missing.
- `done`: all automated evidence and every live boundary pass on the exact same Git SHA.
- `production-ready` is forbidden before concurrent money tests, payment crash tests, restore drill and Owner UAT pass.

The requirement-by-requirement audit for the plans is maintained in
[`completion-audit.md`](./completion-audit.md).  It is deliberately an evidence record, not a
claim that a source-only checkout has passed Discord, TrueMoney, S3, managed PostgreSQL or Owner UAT.
