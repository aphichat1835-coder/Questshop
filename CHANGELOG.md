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
- `LOG_PAYMENTS` may render a full voucher link by Owner policy only on a channel that is hidden from `@everyone`,
  non-Administrator roles and arbitrary member overwrites; privacy drift quarantines the durable surface.
- No Automatic Claim; successful Quest work ends at `READY_TO_CLAIM` with customer-side claim URL.
- Release state remains **implemented-but-unverified** until live UAT passes on one exact Git SHA.

### Added

- Persistent Quest Auto storefront copy with fixed title **Discord Quest • Auto**, Discord Orbs / Discord Token guidance,
  and the existing **เริ่มทำเควส** / **เติมเงิน** controls.
- Dynamic storefront price resolver for the four supported Quest task types. Equal active prices render one amount;
  differing GAME/VIDEO prices render a min-max range; incomplete configuration renders a not-ready price message.
- Immediate post-commit Quest price-change event plus a background surface-refresh listener. This edits the durable
  `QUEST_AUTO` storefront as soon as an Admin category-price transaction commits, while retaining Maintenance as repair fallback.
- Multi-layer expired-Quest guards across Monitor discovery, Monitor test batching, Outbox enqueue and first-time Discord
  delivery. Historical Quest can remain durable evidence without consuming Monitor test attempts or creating stale `QUEST_NEW` spam.
- Integration coverage for first-run expired Quest filtering, Maintenance notification suppression, delivery-time expiry
  races and stopping an active test batch without cycling to another Monitor Token.
- Owner-approved `src/discord/assets/quest-auto-demo.gif` generated from the supplied Quest demo video and rendered
  inside the Quest Auto embed through `attachment://quest-auto-demo.gif`.
- Runtime GIF integrity verification using exact file size `9,190,692` bytes, GIF signature and SHA-256
  `c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1`.
- Surface regression coverage for stale price detection, stale/legacy attachment replacement, invisible nonce-based
  Quest Auto anchor recovery, removal of the legacy visible technical footer, and exact GIF verification.
- Pricing integration coverage proving storefront price-range source changes when the GAME category price changes and
  that the immediate refresh event is emitted only after the committed price is visible.
- Unit coverage proving a committed category-price event immediately schedules the existing surface reconciliation path.
- Quest-new reward normalization for Discord virtual-currency `orb_quantity`, including truthful min-max display for
  multi-value tiered rewards instead of claiming one tier applies to everyone.
- Quest-new static media fallback using Quest Hero/Game Tile/Logotype/application/reward assets and selected-task still
  video thumbnails, while excluding playable video URLs.
- Regression coverage proving current metadata-revision authority: partial payloads may inherit prior presentation
  metadata, while a later complete payload can remove an old image/reward without stale resurrection.
- TrueMoney settlement containment: automatic redemption stops when automatic credit settlement is disabled, financial
  invariant failures close top-up intake immediately, and circuit recovery restores intake only after a successful probe.
- Durable payment recovery for `REDEEMED` rows, including Owner-only escalation for stuck settlement, payment-queue and
  redeemed-stuck incidents, and idempotent credit recovery without another provider call.
- Payment-attempt forensic lineage using `parent_attempt_id`, normalized `error_class` / `error_code`, and regression
  coverage for retry ancestry.
- Payment-specific channel privacy enforcement for `LOG_PAYMENTS`; a later permission drift disables that surface so
  financial Outbox delivery cannot continue through the unsafe durable anchor.

### Changed

- `QUEST_AUTO` no longer hardcodes `5 บาท`; it reads active supported `TYPE` price rules from PostgreSQL.
- Quest Auto media now appears **inside the embed** as an animated GIF instead of a standalone MP4/video attachment
  block above the storefront.
- Quest Auto no longer exposes `Questshop Surface • QUEST_AUTO` to customers. Recovery uses the stable surface nonce,
  with the old footer lookup retained only as a migration fallback for older messages.
- Quest Auto surface reconciliation detects presentation drift independently of runtime config version and edits the
  existing durable message when title/description, price text, expected GIF attachment, embed image or legacy footer is stale.
- A missing or legacy Quest Auto attachment is cleared and replaced with `quest-auto-demo.gif` on the same surface.
- Admin GAME/VIDEO price changes now trigger immediate background reconciliation after the database commit instead of
  waiting for the next ~60-second Maintenance pass. Maintenance remains the fallback if immediate Discord delivery fails.
- Monitor discovery now reconciles `expires_at` before creating a test batch. Already-expired Quest is marked `EXPIRED`,
  kept as history/operations evidence, and never consumes a Monitor Token or public announcement slot.
- A Quest that expires while a Monitor test batch is active stops that batch without switching to another Monitor or
  raising a misleading exhausted-monitor failure alert; retry controls do not restart an already-expired Quest.
- `QUEST_NEW` is expiry-gated again at Outbox enqueue and before first Discord send. Notifications that expire during
  retry/backoff are durably suppressed without pinging a role or marking the Quest as `ANNOUNCED`.
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
- TrueMoney submit now creates the customer Wallet up front, hides durable top-up identity from other users, permits only
  one pending top-up per customer and re-checks the Bangkok daily lock before a queued voucher can be claimed.
- TrueMoney success now requires successful HTTP status, positive amount, consistent single-recipient evidence and a
  safe transaction identifier. Response aborts and inconsistent transport/provider evidence remain ambiguous.
- Automatic credit accepts the established 10–1,000 baht range; successful redemptions outside that range move to
  Owner-only Manual Review rather than being credited automatically.
- Owner manual credit now requires a matching second confirmation within five minutes, and duplicate provider transaction
  identifiers return a business-safe conflict instead of a generic database failure.
- Runtime payment readiness fails closed when payment gates are enabled without an active TrueMoney receiver.

### Removed

- Automatic Quest reward claim / claim retry paths.
- Runtime-wide Permission Drift detector and automatic Discord permission repair; only the narrow `LOG_PAYMENTS`
  confidentiality invariant is enforced.
- Legacy generic branding overrides for the fixed Quest Auto title/description.
- Legacy Base64/re-encoded Quest Auto demo derivative and standalone MP4 storefront presentation.
- The legacy duplicated Quest-new renderer that could still format `ตรวจพบ` / `อัปเดต` independently of Outbox delivery.

### Security

- Quest Auto media bytes fail closed on size/GIF-signature/hash mismatch before upload.
- Money remains integer satang; Wallet/Ledger settlement paths retain serializable/idempotent/fencing protections.
- Logger/Discord boundaries retain secret redaction and deny-by-default mentions; TrueMoney voucher URLs are redacted
  from structured application logs.
- Full TrueMoney voucher-link rendering remains the narrow `LOG_PAYMENTS` exception and is constrained to a private
  Administrator/Owner operational channel.
- Quest reward parsing ignores explicitly non-Orb reward quantities instead of mislabelling them as Discord Orbs.

### Automated evidence

Every candidate Git SHA must freshly pass syntax/check, lint, PostgreSQL-backed coverage, LCOV upload,
fake-adapter load test, `npm audit --audit-level=high` and Docker build. Record the exact passing workflow run with UAT;
a previous green SHA is not evidence for a newer candidate.

These are source/CI results only. Discord GIF rendering, Quest reward/start/expiry/artwork fidelity, first-run historical
Quest filtering, visible price refresh, TrueMoney, live Quest execution, Aiven/inwcloud restart and Owner UAT remain live
evidence boundaries.
