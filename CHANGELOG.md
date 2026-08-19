# Changelog

Questshop follows Keep a Changelog conventions while the package remains in development `0.1.x`.
There is no production release/tag evidence yet; current work remains under `[Unreleased]`.

## [Unreleased]

### Current operational baseline

- Runtime: Node.js `>=22.22.0 <23`, Discord single-Guild, PostgreSQL 16+.
- inwcloud command: `npm ci --omit=dev && npm run deploy && npm start`.
- `DATABASE_DIRECT_URL` = Migrator role; `DATABASE_POOL_URL` = Runtime role; both production URLs use
  `sslmode=verify-full`.
- `BACKUP_MODE=AIVEN_MANAGED` is the default provider boundary for Aiven.
- `LOG_PAYMENTS` may render a full voucher link by Owner policy without runtime human-visibility/privacy checks.
- No Automatic Claim; successful Quest work ends at `READY_TO_CLAIM` with customer-side claim URL.
- Release state remains **implemented-but-unverified** until live UAT passes on one exact Git SHA.

### Added

- Persistent Quest Auto storefront copy with fixed title **Discord Quest • Auto**, Discord Orbs / Discord Token guidance,
  and the existing **เริ่มทำเควส** / **เติมเงิน** controls.
- Dynamic storefront price resolver for the four supported Quest task types. Equal active prices render one amount;
  differing GAME/VIDEO prices render a min-max range; incomplete configuration renders a not-ready price message.
- Exact Owner-uploaded `src/discord/assets/videoplayback.mp4` as the fixed Quest Auto demo asset.
- Runtime MP4 integrity verification using exact file size `6,812,564` bytes, MP4 `ftyp` marker and SHA-256
  `0a09d0088a30cc90722af5c1602b4335853246a28ccd46d321cc7c5b64efa467`.
- Surface regression coverage for stale price detection, stale/legacy attachment replacement, preserving the correct
  attachment without duplicate upload, and exact uploaded-video size/container verification.
- Pricing integration coverage proving storefront price-range source changes when the GAME category price changes.

### Changed

- `QUEST_AUTO` no longer hardcodes `5 บาท`; it reads active supported `TYPE` price rules from PostgreSQL.
- Quest Auto surface reconciliation now detects presentation drift independently of runtime config version and edits
  the existing durable message when title/description/footer, price text or expected video filename is stale.
- A missing or legacy Quest Auto attachment is cleared and replaced with `videoplayback.mp4` on the same surface.
- Automatic price/media healing is driven by the normal Maintenance reconciliation path, currently approximately once
  per 60 seconds, plus setup/restart repair. This is eventual automatic refresh rather than a synchronous same-click
  price update guarantee.
- Documentation was synchronized across README, engineering/security contracts, architecture, deployment, runbooks,
  traceability, Definition of Done and UAT evidence so source behavior and live boundaries use the same wording.
- Discord response controller preserves `ModalBuilder` instances and persistent interaction sessions bind to their
  rendered message before controls become usable.
- Backoffice authorization uses `OWNER_ID` or current Discord `Administrator` permission at every interaction instead
  of a configured Admin Role ID.
- Surface setup/reconciliation recreate only on confirmed missing-message errors; permission/network/rate-limit errors
  preserve the authoritative pointer and incident evidence.
- Runtime/PostgreSQL role synchronization and TLS CA handling remain fail-closed and do not use the old
  `NODE_EXTRA_CA_CERTS` workaround.

### Removed

- Automatic Quest reward claim / claim retry paths.
- Runtime Permission Drift detector and automatic Discord permission repair.
- Human-visibility/privacy preflight around backoffice setup and Payment Log delivery, per explicit Owner policy.
- Legacy generic branding overrides for the fixed Quest Auto title/description.
- Legacy Base64/re-encoded Quest Auto demo derivative; the source now uses the exact Owner-uploaded MP4 directly.

### Security

- Quest Auto media bytes fail closed on size/container/hash mismatch before upload.
- Money remains integer satang; Wallet/Ledger settlement paths retain serializable/idempotent/fencing protections.
- Logger/Discord boundaries retain secret redaction and deny-by-default mentions.
- Full TrueMoney voucher-link rendering remains the narrow `LOG_PAYMENTS` exception only.

### Automated evidence

Latest source gate for the Quest Auto work passed:

- syntax/check ✅
- lint ✅
- PostgreSQL-backed test coverage ✅
- LCOV artifact upload ✅
- fake-adapter load test ✅
- `npm audit --audit-level=high` ✅
- Docker build ✅

These are source/CI results only. Discord playback, visible price refresh, TrueMoney, live Quest execution,
Aiven/inwcloud restart and Owner UAT remain live evidence boundaries.

### Known live boundaries

- Verify `videoplayback.mp4` playback in real Discord desktop/mobile clients.
- Change Admin GAME/VIDEO pricing and confirm the same `QUEST_AUTO` message refreshes within the Maintenance window
  without a duplicate panel.
- Verify restart/setup repair of stale/missing Quest Auto media on the live Guild.
- Complete TrueMoney success/ambiguity/schema-drift UAT.
- Complete supported Video/Desktop Quest UAT and Discord-account risk review.
- Verify managed PostgreSQL TLS/roles, inwcloud restart, rollback rehearsal and Owner pre-launch closeout on one SHA.
