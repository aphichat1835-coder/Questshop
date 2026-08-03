# Module definition of done

Each module is complete only when the listed code contract, migration/index, authorization boundary,
idempotency/concurrency behavior, observability, feature gate, tests, rollback path and runbook exist.

| Module | Done criteria |
|---|---|
| Foundation | validated environment; separate direct/pooled/backup/restore roles; migration checksum and compatibility; runtime lease; health-first startup; 25-second shutdown |
| Wallet | integer satang; row lock; serializable retry; append-only hash chain; reservation states; compensation and checkpoint retention |
| Payment | voucher allowlist/HMAC; receiver/promotion snapshot; intent phase; no blind retry after possible send; exact-once credit; Owner-only ambiguity |
| Catalog | three independent axes; immutable metadata revisions; dynamic price; executor support; expiry admission; discovery does not identify customer |
| Checkout | actor/guild/channel-bound session; encrypted token; pagination; quote hash/version; signed 30-second external preflight; account uniqueness; bulk item reserve |
| Queue/Runner | fair scheduling; lazy materialization; durable mutation checkpoint; lease/fencing; bounded retry; fresh verification; capture/release; no claim API |
| Outbox | transactionally enqueued projection; latest-state rendering; heartbeat and fencing for event/projection leases; nonce reconciliation; Discord error contract; durable attempts; replay-linked DLQ |
| Discord UI | persistent setup/update/move; ephemeral secrets; allowed-mention allowlist; terminal controls disabled; Thai/mobile-safe content |
| Admin | Owner/Admin split; preview and confirmation for money/repair/receiver; reason/correlation/audit; no token read path |
| Operations | permission drift; incidents and feature containment; metrics/SLO evaluator; encrypted streaming backup; restore drill; retention/key rotation |

The evidence command set is `npm run check`, `npm run lint`, PostgreSQL-backed `npm test`, `npm audit`,
Docker build and the fake-adapter load test. Live Discord, TrueMoney, S3 and managed-database evidence is tracked
separately in `traceability.md` and `uat/prelaunch.md`.
