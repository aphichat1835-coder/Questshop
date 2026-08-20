# Completion audit — Questshop

This document is the source/test evidence ledger. It does not replace live Discord, TrueMoney, Quest, Aiven or Owner UAT.
Current completion label is **implemented-but-unverified**.

## Owner decisions currently in force

1. One production Discord Guild, all-in-one Node.js runtime, PostgreSQL 16+ durable source of truth.
2. Money uses integer satang; Confirm reserves per Item; verified success captures; definite failure releases;
   ambiguous results remain Reserved for Manual Review.
3. No Automatic Claim. Completed Quest work ends at `READY_TO_CLAIM` with customer-side claim URL.
4. Monitor accounts always Scan + Test. Monitor-discovered Quest stays private until one test passes or audited Admin
   **ส่งเลย**; customer-discovered Quest may be admitted only for that authenticated Quest account and public output
   must not identify the customer.
5. Admin authorization is `OWNER_ID` or current Discord `Administrator` permission at each interaction.
6. Owner manages backoffice channel privacy. Runtime does not perform human-visibility/privacy preflight or permission
   drift auto-repair. `LOG_PAYMENTS` may contain a full voucher link.
7. Production DB Runtime/Migrator roles remain separate and TLS uses `sslmode=verify-full`.
8. Aiven-managed backup is the default provider boundary; Questshop does not claim a local restore drill in this mode.

## Later Owner storefront decision — Quest Auto

`QUEST_AUTO` is one durable Discord storefront message with fixed title **Discord Quest • Auto**, approved Thai copy,
buttons **เริ่มทำเควส** / **เติมเงิน**, dynamic price summary and one exact Owner-approved GIF rendered inside the embed.
The customer-facing Quest Auto embed does not display the technical `Questshop Surface • QUEST_AUTO` footer.

### Price contract

Source: `src/domain/pricing/resolver.js`, `src/discord/renderers/surfaces.js`, `src/discord/surfaces/setup.js`.

- All four supported active `TYPE` task prices must exist before the storefront claims a configured price.
- Equal prices collapse to one value such as `5 บาท`.
- Differing GAME/VIDEO values render a min-max range such as `5-7 บาท`.
- Incomplete supported configuration renders `ค่าบริการยังไม่พร้อม`.
- Surface reconciliation compares the current Discord presentation against the expected price text even if runtime
  config version did not change.
- Maintenance currently reconciles approximately every 60 seconds; therefore Admin price edits are automatic eventual
  storefront refresh, not a synchronous same-click guarantee.

Automated evidence:

- `test/integration/pricing-promotion-contract.test.js`
- `test/unit/quest-auto-surface.test.js`
- `test/unit/surface-anchor.test.js`
- `test/integration/outbox-dlq.test.js`

### Media contract

Source asset:

```text
src/discord/assets/quest-auto-demo.gif
Size     9,190,692 bytes
SHA-256  c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1
```

Runtime verifies exact size, GIF signature and SHA-256 before upload. The message attachment is referenced by the Rich
Embed as `attachment://quest-auto-demo.gif`, so the customer sees the animation inside the embed instead of a standalone
MP4/video block. A stale or legacy attachment is cleared and replaced on the same durable anchor. An already-correct
`quest-auto-demo.gif` attachment is preserved to avoid duplicate upload.

Quest Auto recovery prefers the stable surface nonce so the technical footer can remain hidden. Legacy footer lookup is
retained only as a migration fallback for older storefront messages.

Important future-change rule: Discord-side drift detection identifies the expected GIF by filename. If the GIF bytes
intentionally change later, version/change the filename or add an explicit attachment migration.

Live boundary: real Discord desktop/mobile GIF rendering inside the embed, removal of the old visible technical footer,
visible price refresh within the Maintenance window, restart/setup repair and no duplicate panel must still be verified
on one exact Git SHA.

## Requirement matrix

| Area | Primary implementation | Automated evidence | Live boundary |
|---|---|---|---|
| Runtime / source identity | config, bootstrap, `GIT_SHA`, Node 22 | env/source-version/startup tests | exact inwcloud checkout + restart |
| PostgreSQL TLS / roles | pools, migrations, role sync/validator | PostgreSQL 16 role/TLS tests | Aiven role + CA verification |
| Wallet / Ledger | wallet services, reservations, append-only tables | concurrency/settlement/refund tests | Owner compensation sign-off |
| TrueMoney | adapter, payment worker/service | canonical URL/schema/ambiguity/crash tests | real low-value + ambiguous UAT |
| Pricing / promotions | pricing resolver, Admin config service | category + promotion integration tests | Owner Admin pricing UAT |
| Quest Auto storefront | renderer, surface setup/reconcile, exact GIF | price/media/surface tests | in-embed animation + visible refresh |
| Catalog / Monitor | catalog, discovery/test workers | Monitor gate, contract-pinning tests | live metadata drift + Monitor UAT |
| Checkout | checkout domain + router | session/quote/account-lock tests | mobile Discord UAT |
| Runner | runner service, executors, leases/fencing | crash/retry/atomic settlement tests | live supported Quest execution |
| Outbox / Discord delivery | outbox services/workers, transport | 403/404/429, coalescing, DLQ tests | real Discord failure UAT |
| Admin / Review | Admin router + domain services | authorization/session/review tests | Owner/Admin workflow UAT |
| Health / alerts | health server, worker manager, alerts | status/auth/SLO tests | external alert delivery |
| Aiven backup policy | env/deployment policy | Aiven-managed skip/audit tests | Aiven Console recovery evidence |
| Deployment / rollback | Docker, CI, deploy scripts | coverage/load/audit/Docker | same-SHA deploy + rollback rehearsal |
| UAT / release | prelaunch scripts/docs | source gates only | all rows in UAT evidence template |

## Automated evidence status

The latest completed source gate before the GIF layout switch passed the full repository gate. The final GIF-layout SHA
must pass the same gate again before its automated evidence is considered current:

- `npm run check`
- `npm run lint`
- PostgreSQL-backed `npm run test:coverage`
- LCOV artifact upload
- fake-adapter `npm run load:test`
- `npm audit --audit-level=high`
- Docker build

These results prove source contracts only. They do not prove provider/live behavior.

## Explicit non-claims

Do not represent these as completed without controlled live evidence:

1. production Discord login/registration, mobile layout, GIF-in-embed animation and live persistent-surface recovery;
2. real TrueMoney redemption and post-send ambiguous resolution;
3. real supported Video/Desktop Quest execution;
4. managed PostgreSQL TLS/least-privilege provisioning and recovery operation;
5. same-SHA Owner closeout, rollback rehearsal and alert delivery.

## Release state

`done` requires every applicable automated and live boundary to pass on the same Git SHA.
Until then the correct label is **implemented-but-unverified**, never production-ready.
