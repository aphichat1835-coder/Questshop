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
- Owner-approved `src/discord/assets/quest-auto-demo.gif` generated from the supplied Quest demo video and rendered
  inside the Quest Auto embed through `attachment://quest-auto-demo.gif`.
- Runtime GIF integrity verification using exact file size `9,190,692` bytes, GIF signature and SHA-256
  `c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1`.
- Surface regression coverage for stale price detection, stale/legacy attachment replacement, invisible nonce-based
  Quest Auto anchor recovery, removal of the legacy visible technical footer, and exact GIF verification.
- Pricing integration coverage proving storefront price-range source changes when the GAME category price changes.
- Quest-new reward normalization for Discord virtual-currency `orb_quantity`, including truthful min-max display for
  multi-value tiered rewards instead of claiming one tier applies to everyone.
- Quest-new static media fallback using Quest Hero/Game Tile/Logotype/application/reward assets and selected-task still
  video thumbnails, while excluding playable video URLs.
- Regression coverage proving current metadata-revision authority: partial payloads may inherit prior presentation
  metadata, while a later complete payload can remove an old image/reward without stale resurrection.

### Changed

- `QUEST_AUTO` no longer hardcodes `5 บาท`; it reads active supported `TYPE` price rules from PostgreSQL.
- Quest Auto media now appears **inside the embed** as an animated GIF instead of a standalone MP4/video attachment
  block above the storefront.
- Quest Auto no longer exposes `Questshop Surface • QUEST_AUTO` to customers. Recovery uses the stable surface nonce,
  with the old footer lookup retained only as a migration fallback for older messages.
- Quest Auto surface reconciliation detects presentation drift independently of runtime config version and edits the
  existing durable message when title/description, price text, expected GIF attachment, embed image or legacy footer is stale.
- A missing or legacy Quest Auto attachment is cleared and replaced with `quest-auto-demo.gif` on the same surface.
- Automatic price/media healing is driven by the normal Maintenance reconciliation path, currently approximately once
  per 60 seconds, plus setup/restart repair. This is eventual automatic refresh rather than a synchronous same-click
  price update guarantee.
- Quest-new customer announcements now show Discord Quest **เริ่ม Quest** (`starts_at`) and **หมดอายุ** (`expires_at`)
  instead of scanner **ตรวจพบ** / mutable **อัปเดต** timestamps.
- `QUEST_NEW` now has one customer-facing renderer source: generic projection rendering and Outbox delivery both route
  to `renderQuestNewProjection()`.
- Quest presentation metadata is read from the exact current durable revision; an older non-null thumbnail is no longer
  selected merely because the current complete revision removed it.
- Documentation is synchronized across engineering contracts, traceability and UAT evidence so Quest Auto and Quest-new
  source behavior and live boundaries use the same wording.
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
- Legacy Base64/re-encoded Quest Auto demo derivative and standalone MP4 storefront presentation.
- The legacy duplicated Quest-new renderer that could still format `ตรวจพบ` / `อัปเดต` independently of Outbox delivery.

### Security

- Quest Auto media bytes fail closed on size/GIF-signature/hash mismatch before upload.
- Money remains integer satang; Wallet/Ledger settlement paths retain serializable/idempotent/fencing protections.
- Logger/Discord boundaries retain secret redaction and deny-by-default mentions.
- Full TrueMoney voucher-link rendering remains the narrow `LOG_PAYMENTS` exception only.
- Quest reward parsing ignores explicitly non-Orb reward quantities instead of mislabelling them as Discord Orbs.

### Automated evidence

Every candidate Git SHA must freshly pass syntax/check, lint, PostgreSQL-backed coverage, LCOV upload,
fake-adapter load test, `npm audit --audit-level=high` and Docker build. Record the exact passing workflow run with UAT;
a previous green SHA is not evidence for a newer candidate.

These are source/CI results only. Discord GIF rendering, Quest reward/start/expiry/artwork fidelity, visible price refresh,
TrueMoney, live Quest execution, Aiven/inwcloud restart and Owner UAT remain live evidence boundaries.
