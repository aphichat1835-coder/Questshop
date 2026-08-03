# Completion audit — Questshop plans

This is an evidence ledger for the two authoritative plans:

- `แผน Questshop ฉบับ Final Decision-Complete`
- `Technical Blueprint: Questshop Production`

The Final Decision-Complete plan wins if the documents differ.  This record is a source and
automated-test audit; release evidence must record `git rev-parse HEAD` at the time each command
or live check runs.  It does **not** replace the live evidence required for a production release.

## Evidence used

| Evidence | Result |
|---|---|
| Node `22.22.0`, PostgreSQL `16`, `npm run verify` | Passed: syntax, ESLint and 58 tests |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities reported |
| `git diff --check` | Passed |
| Git tracked files | Neither legacy reference project is tracked; both are ignored locally |

The test database was a disposable local PostgreSQL container.  It is evidence for the database
contracts, not evidence for a managed production service.

## Final Decision-Complete plan

| Plan section | Source/test evidence | Status and remaining boundary |
|---|---|---|
| 1. Scope and runtime | `package.json`, `src/config/env.js`, `src/bootstrap/*`, `Dockerfile` | Source-confirmed. Actual inwcloud memory/deploy evidence remains. |
| 2. `quest-auto`, `quest-new`, history and setup commands | `src/discord/{commands,interactions,renderers,surfaces}`, `test/security/interactions.test.js`, `test/integration/outbox-dlq.test.js` | Source-confirmed. Real Guild/mobile interaction and persistent-component UAT remain. |
| 3. Admin, blocklist and four log surfaces | `src/domain/admin`, `src/domain/blocklist`, `src/discord/renderers/projections.js` | Source-confirmed. Owner/Admin role and private-channel UAT remain. |
| 4. Fixed state machines | domain `states.js`, `migrations/0001_initial.sql`, `test/unit/states.test.js` | Source-confirmed. Production trace sampling remains. |
| 5. Error classes, retry and backoff budgets | payment, runner, outbox services/workers and their crash/fault tests | Source-confirmed for simulated errors. Provider and Discord error behaviour remains live evidence. |
| 6. Fair queue, lease, lock and fencing | `src/domain/runner/service.js`, `src/db/leases.js`, concurrency/crash tests | Source-confirmed. Runtime contention at production load remains. |
| 7. Manual review | `src/domain/reviews`, Admin router and atomic review test | Source-confirmed. Owner workflow UAT remains. |
| 8. Discovery, monitor and expiry | catalog services, monitor worker, expiry service, catalog-retest test | Source-confirmed. Live Quest metadata/contract drift remains. |
| 9. TrueMoney Direct and receiver versions | `src/adapters/truemoney`, payments, receiver service and voucher/crash tests | Source-confirmed with pinned fixtures. A real low-value success, ambiguous result and schema-drift test remain mandatory. |
| 10. Wallet, price and promotion | wallet/ledger/pricing/promotion domains and settlement tests | Source-confirmed. Owner financial pre-launch compensation sign-off remains. |
| 11. Interaction security and Discord rate limits | opaque component IDs, server sessions, outbox and security tests | Source-confirmed. Actual Discord REST/Gateway behaviour remains. |
| 12. Correlation and PostgreSQL time | correlation, transition, transaction and PostgreSQL time modules | Source-confirmed. Managed database clock/role observation remains. |
| 13. PostgreSQL production contract | pools, transaction wrapper, migrations, `postgresql-roles.md` | Source-confirmed. Managed PostgreSQL TLS, role grants and backup roles remain. |
| 14. Startup, shutdown and health | bootstrap, shutdown, health server and worker manager | Source-confirmed. Deployment/restart drill remains. |
| 15. Permission drift | permission monitor/repair and security tests | Source-confirmed. Real overwrite drift/repair remains. |
| 16. Engine/config versioning | versions, config service, runner pinning and compatibility test | Source-confirmed. N/N-1 deployment drain remains. |
| 17. Retention and secrets | keyring, retention/key workers, migrations and coverage tests | Source-confirmed. Live key rotation plus restore test remains. |
| 18. Backup and restore | encrypted S3 adapter, backup/restore scripts and fake-S3 contract tests | Source-confirmed. Real S3 upload and temporary managed-DB restore drill remain. |
| 19. Deployment, rollback and pre-launch | Docker, CI workflow, pre-launch scripts/docs and an Owner/Admin-only pre-launch router guard | Source-confirmed. Same-SHA deploy, rollback and Owner closeout remain. |
| 20. SLO, alerts and capacity | alert worker, health/status, load test script and tests | Source-confirmed. External alert delivery and monthly SLO evidence remain. |
| 21. Runbooks | `docs/runbooks/README.md` | Source-confirmed. Execution during drills/incidents remains. |
| 22. Development sequence and feature gates | feature-gate config, Admin controls and pre-launch document | Source-confirmed. Owner must enable gates in the required live order. |
| 23. Definition of Done and acceptance | definition-of-done, traceability and 57 automated tests | Not complete until every remaining live boundary above passes on the same SHA. |

## Technical Blueprint plan

| Blueprint group | Source/test evidence | Status and remaining boundary |
|---|---|---|
| 1. Architecture, dependencies and code layout | root `package.json`; `src/`, `migrations/`, `scripts/`, `docs/`, `test/` | Source-confirmed. Actual host resource profile remains. |
| 2. Domain contracts and PostgreSQL schema | domain services, migration checksum runner, migration integration test | Source-confirmed. Production migration execution remains. |
| 3. Financial, checkout, runner and outbox logic | payment/wallet/checkout/runner/outbox services plus concurrency/crash tests | Source-confirmed for all simulated acceptance paths. Live external mutation paths remain. |
| 4. Discord UX, Admin, security and operations | router, renderers, surfaces, permissions, health and operations workers | Source-confirmed. Real client layout, permissions and acknowledgement latency remain. |
| 5. Development gates and proof plan | CI, Dockerfile, test suites, load test, UAT and runbooks | Automated local gate is passed. Production gates are still intentionally closed until Owner UAT. |

## Explicit non-claims

The following cannot be represented truthfully as completed without credentials and a controlled live
environment.  They are not source-code defects and must not be bypassed by replacing real adapters with
fixtures:

1. A production Discord bot login, guild command registration, channel permission setup, mobile UX and
   restart recovery.
2. A real TrueMoney direct redemption, including the ambiguous-after-send path and Owner-only decision.
3. A real Quest account run for each supported task type.  This must also be reviewed against Discord's
   current terms before use; the code deliberately contains no automatic-claim API.
4. Managed PostgreSQL TLS verification, least-privilege roles, production migration and a temporary-DB
   restore drill from a real encrypted S3-compatible backup.
5. Same-SHA Owner pre-launch closeout, gate-by-gate opening, rollback rehearsal, alert delivery and
   time-based SLO evidence.

## Release state

The correct completion label at this revision is **`implemented-but-unverified`**.  It becomes `done`
only when the pre-launch checklist in [`../uat/prelaunch.md`](../uat/prelaunch.md) and every live boundary
in this document are recorded successfully for this exact Git SHA.  Do not call it production-ready before
then.
