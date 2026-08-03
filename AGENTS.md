# AGENTS.md — Questshop engineering contract

This file applies to the repository root and every descendant path unless a more specific `AGENTS.md`
exists below it. User instructions override this file when they explicitly change product policy, but an
agent must call out any conflict with financial integrity, credential safety, destructive scope, or live
production authority before acting.

## Mission and evidence

Questshop is a single-guild Discord storefront for automated Quest progress. Preserve these distinctions:

- Source implementation, local tests, GitHub checks, deployment health, and live Discord/provider UAT are
  separate evidence boundaries.
- The valid pre-production completion label is `implemented-but-unverified` until every live boundary in
  `docs/uat/prelaunch.md` passes on one exact Git SHA.
- Never claim `production-ready`, live Discord success, TrueMoney success, restore success, or deployment
  success without direct evidence from that environment.

Authoritative project references:

1. Current explicit Owner instructions.
2. `docs/architecture/completion-audit.md` for later policy decisions.
3. `docs/architecture/traceability.md` and `docs/architecture/definition-of-done.md`.
4. `docs/state-machines/contracts.md` and domain `states.js` files.
5. `README.md`, `SECURITY.md`, and runbooks for operational guidance.

## Protected product decisions

Do not change these without an explicit Owner decision:

- One production Discord Guild; all-in-one runtime; PostgreSQL 16+ is the durable source of truth.
- Node.js `>=22.22.0 <23`, JavaScript ESM, `discord.js`, `pg`, and no ORM/Redis in v1.
- Refunds are Wallet credit only, never cash, transfer, or withdrawal; Wallet credit does not expire.
- Available and Reserved balances are separate. Confirm reserves per item; verified success captures;
  definite failure releases; ambiguity remains reserved for review.
- No customer cancellation or dispute button in v1. Admin/Owner opens Manual Review.
- No Automatic Claim. Do not add a Claim API, claim mutation, claim retry, or background reward collection.
  Completed work ends at `READY_TO_CLAIM` with a URL button for manual claim.
- Customer tokens are not ownership-bound by policy, but one Quest Account ID may have only one active job
  globally. Do not silently add ownership checks or consent records.
- Customer tokens are order/session scoped and deleted after terminal use. Monitor tokens are never reused as
  customer credentials, and customer tokens never become Monitor credentials automatically.
- Monitor accounts always have both Scan and Test behavior. Do not add capability selection or a required
  artificial reason to add a Monitor.
- A Monitor-discovered Quest stays private until one Monitor test passes or an audited Admin **ส่งเลย**
  override. Try up to three times per Monitor and stop the batch on the first verified pass.
- A customer-discovered Quest may be cataloged/announced after analysis and admitted for that authenticated
  Quest account under checkout policy. Backoffice evidence may include the Discord customer and Quest account
  identity, but never the raw token. Public `quest-new` must not identify the customer.
- `quest-new` does not show Quest ID, test state, or internal sale state.
- Quest select option copy stays compact: type, Orbs, progress, and price. Expiry belongs in the quote/review
  page, not the select option.
- Final order DM uses one **รับรางวัลทั้งหมด** link to the first successful Quest and keeps
  **ดูประวัติ Quest ทั้งหมด** linked to the history channel.
- Branding media is an image/GIF URL in v1; do not build a video subsystem without a new requirement.
- Runtime Permission Drift detection/repair was intentionally removed. Keep one-time setup permission checks;
  record Discord 403 incidents and require manual Owner repair.
- Full voucher links are allowed only in the validated private `LOG_PAYMENTS` surface by Owner policy.
- Legacy reference directories are local-only and excluded from the root import/test graph.

## Architecture boundaries

- Discord handlers validate input, acknowledge exactly once, reauthorize, and call domain services. They must
  not update Wallet, Ledger, payment, order, runner, catalog sale, review, or outbox business state directly.
- Domain services own transactions, transitions, idempotency, audit, and outbox writes.
- Every aggregate transition uses the domain transition map, `state_version`, compare-and-swap, correlation
  context, and an audit/transition record where required.
- Financial operations use integer satang (`BIGINT`/`BigInt`), never floating point. Use shared money parsers
  and formatters.
- Financial transactions use `SERIALIZABLE` with bounded whole-transaction retry. Queue/outbox acquisition
  uses `READ COMMITTED`, row locks, and `FOR UPDATE SKIP LOCKED` where established.
- Do not hold a PostgreSQL transaction across Discord, TrueMoney, Quest API, S3, or another external call.
- External mutations require a durable intent/checkpoint before send and verification afterward. Never blind
  retry a mutation that may already have been sent.
- Worker commits require lease owner, fencing token, and state version. A stale worker must stop after a
  zero-row update or lease-loss signal.
- Use PostgreSQL time for money, lease, expiry, deadline, and retention decisions. Node monotonic time is for
  latency measurement only.
- Write Discord messages through projection/outbox for durable background delivery. Preserve latest-state-wins
  coalescing, bounded retry, and DLQ rules.
- Persistent components route through versioned opaque custom IDs and server-side actor/guild/channel/message/
  operation/expiry checks. Do not use custom ID contents as authorization.

## Database and migrations

- Never edit an already-applied migration. Add the next zero-padded migration under `migrations/`.
- Keep migration checksums stable and schema enum/check constraints synchronized with JavaScript state maps.
- Use Expand → Migrate → Contract across releases for breaking schema changes. Do not add automatic down
  migrations.
- Runtime role has no DDL and must not receive `UPDATE`/`DELETE` on `wallet_transactions` or
  `admin_audit_logs`. Retention goes through the bounded security-definer functions.
- Preserve separate runtime, migration, backup, and restore roles and TLS `verify-full` in production.
- Do not destroy or recreate a non-disposable database. `scripts/load-test.js` is allowed only when the database
  name contains `questshop_loadtest`.

## Money and payment invariants

- Ledger and Admin audit are append-only. Repairs are compensating transactions with reason, actor,
  correlation ID, preview, fresh authorization, and confirmation.
- Reserved balance changes only through Reserve/Capture/Release domain paths.
- Voucher identity is protected by versioned HMAC plus a unique constraint. Receiver and Promotion are
  snapshotted when the top-up is created.
- `REDEEMED` and `CREDITED` are different states. A crash between them must credit exactly once on recovery.
- After a TrueMoney request may have been sent, use verification or Owner-only `AMBIGUOUS/MANUAL_REVIEW`;
  never blind retry.
- Provider/schema/receiver/amount/currency uncertainty must fail closed without credit.
- Over-limit vouchers credit the full amount actually received, create a warning, and block additional top-ups
  until the Bangkok day boundary. Never confiscate or silently hold the excess.
- Financial/Audit DLQ is replayable but never discardable.

## Credential and privacy rules

- Never print, log, return, fixture, screenshot, commit, or paste a Discord bot/user token, cookie, session,
  voucher code/link, database URL, S3 secret, encryption/HMAC key, or decrypted receiver value.
- First-run setup may generate `STATUS_TOKEN` and independent Data/Voucher/Backup keyrings exactly once.
  Re-running setup must preserve existing values. Never silently regenerate, derive from a Discord/DB secret,
  or replace a keyring during startup.
- The generated `.env` is an owner-only `0600` secret file. Stateless/container deployments must mount it
  from durable secret storage or transfer its values to a secret manager before redeploying.
- Exception: a full voucher link may be rendered only by the payment-log projection to the validated private
  `LOG_PAYMENTS` surface. Do not broaden this exception.
- Use versioned AES-256-GCM keyrings with random nonces and context-specific AAD for stored secrets.
- Admin has no credential read/decrypt route. Secret status UI shows versions/health only.
- Treat custom IDs, modal input, Markdown, URLs, media, provider output, and raw metadata as untrusted.
- Keep `allowedMentions` deny-by-default and explicitly allow only intended users/roles.
- Redact structured logs through the central redaction/logger path; do not log raw provider responses.

## Discord UX contract

- Customer-specific Token, Wallet, selection, quote, top-up, and errors stay Ephemeral.
- Use one dominant primary action per decision surface, truthful Thai copy, semantic colors, and actionable
  recovery. Do not expose raw enum values to customers.
- Store exact progress but edit history only when state, 25% bucket, or claim URL changes.
- One Quest announcement/history/job summary uses one message and edits it rather than spamming updates.
- Respect Discord limits: custom ID ≤100, button label ≤80, one select per Action Row, ≤5 buttons per Action
  Row, and ≤5 Action Rows. Test long Thai names and mobile scanning.
- Defer/acknowledge before work that can exceed the interaction deadline. Each path has one response owner.
- Disable or replace terminal controls. Re-load and authorize every side effect at the action boundary.
- Keep backoffice diagnostics detailed, but public/customer surfaces use localized labels and safe explanations.

## Feature gates and operations

All feature gates default closed. Immediate financial invariants close only affected gates and preserve
evidence. Do not enable production gates, alter live Discord permissions, publish commands, deploy, or perform
real provider mutations without explicit authority.

Startup order, graceful shutdown, health endpoints, backup, restore, retention, alerting, and runbooks are part
of correctness. A Runtime lease loss must mark not-ready, stop ingress/dequeue, clean up, and terminate; it is
not a recoverable warning.

## Development workflow

Before editing:

1. Read the nearest code, relevant tests, current branch/status, and applicable docs.
2. Preserve unrelated dirty/untracked user work. The local ZIP and legacy reference directories are not task
   inputs unless explicitly requested.
3. Define observable acceptance and the live boundary. Ask only when a missing choice materially changes money,
   security, destructive scope, external side effects, or architecture.

During implementation:

- Follow existing ESM, repository layout, SQL style, domain interfaces, correlation context, and error classes.
- Keep `.env.example` limited to external first-run inputs. Runtime defaults and generated secrets belong to
  the idempotent setup flow; external S3/database credentials must never be fabricated.
- Prefer a small coherent change over a parallel framework or speculative abstraction.
- Use `apply_patch` for manual file edits. Do not rewrite unrelated files or format the whole repository.
- Add fails-before/passes-after regression coverage for defects and risk-scaled tests for features.
- Preserve safe startup/shutdown, idempotency, retry budgets, replay evidence, and rollback compatibility.

Required verification for ordinary source changes:

```bash
npm run check
npm run lint
TEST_DATABASE_URL=<disposable-postgresql-16-url> npm test
git diff --check
```

Use focused tests first, then the full suite for cross-domain, Discord, money, worker, migration, security, or
recovery changes. For release evidence also run `npm audit --audit-level=high`, the disposable load test,
Docker build, and the live UAT checklist on the exact SHA.

## Git, release, and protected paths

- Do not commit, push, open/update a PR, resolve review threads, merge, deploy, register live commands, or enable
  gates unless the user explicitly requests that action.
- Never force-push, rewrite published history, discard user changes, delete branches, or use destructive Git
  commands without explicit scope and approval.
- Stage only intended files. Never add `.env`, dumps, backups, ZIP archives, credentials, or local legacy
  reference projects.
- Do not claim a check passed from an older SHA or from another environment. Record exact SHA for release/UAT.
- Update `CHANGELOG.md` under `[Unreleased]` for user-visible, security, migration, configuration, or operational
  changes. Do not invent a release date or tag.
- Keep README, `.env.example`, runbooks, traceability, and security policy aligned when behavior changes.
