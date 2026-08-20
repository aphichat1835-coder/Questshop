# AGENTS.md — Questshop engineering contract

This contract applies from the repository root to every descendant unless a nearer `AGENTS.md` replaces part of it.
Current explicit Owner instructions take precedence, but an agent must call out a conflict with money integrity,
credential safety, destructive scope or live-production authority before acting.

## 1. Mission, evidence and authority

Questshop is a one-Guild Discord storefront for automated Discord Quest progress. It uses Node.js 22,
`discord.js`, `pg` and PostgreSQL 16+ as the durable source of truth.

Keep these evidence boundaries separate:

1. source implementation and local tests;
2. GitHub/static-analysis checks;
3. deployment health on the exact Git SHA;
4. Discord, TrueMoney, Quest Engine and Owner UAT in the live environment.

Until every applicable item in [docs/uat/prelaunch.md](docs/uat/prelaunch.md) passes on one exact SHA, the strongest
allowed completion label is **implemented-but-unverified**. Never claim production-ready, a live provider success,
restore success, deployment success or command-registration success without direct evidence from that environment.

Do not deploy, alter inwcloud/Aiven/Discord live settings, register live commands, enable gates, mutate real payment
or Quest data, open/merge a PR, push, force-push, delete a branch or rewrite published history unless the Owner
explicitly requests that exact action.

Primary references, in order:

1. current explicit Owner instructions;
2. [docs/architecture/completion-audit.md](docs/architecture/completion-audit.md);
3. [docs/architecture/traceability.md](docs/architecture/traceability.md) and
   [docs/architecture/definition-of-done.md](docs/architecture/definition-of-done.md);
4. [docs/state-machines/contracts.md](docs/state-machines/contracts.md) and each domain `states.js`;
5. [README.md](README.md), [SECURITY.md](SECURITY.md) and runbooks.

## 2. Product decisions that require an Owner decision to change

- One production Discord Guild, all-in-one runtime, PostgreSQL 16+ durable state; no ORM, Redis, web dashboard,
  multi-Guild or customer cancellation/dispute flow in v1.
- Node.js `>=22.22.0 <23`, JavaScript ESM, `discord.js` and `pg` remain the runtime contract.
- Money uses integer satang only. Wallet credit never expires and cannot be withdrawn or transferred.
- Confirm reserves each Item; verified success captures; definite failure releases; ambiguity stays reserved for
  Manual Review. Refunds are Wallet credit only.
- Ledger and Admin audit are append-only. Corrections use compensating transactions, never an update/delete of
  historical entries.
- No Automatic Claim. Do not add claim API/mutation/retry/background collection. Completed work ends at
  `READY_TO_CLAIM` with a URL button.
- Customer Token ownership is intentionally not checked, but one Quest Account ID has no more than one active job
  globally. Customer credentials are session/order scoped and never become Monitor credentials.
- Monitor accounts always Scan and Test. A Monitor-discovered Quest remains private until one Monitor test passes or
  an audited Admin **ส่งเลย** override; try a Monitor at most three times and stop on first verified pass.
- A customer-discovered Quest can be analyzed and admitted for that authenticated Quest account under Checkout policy.
  Backoffice evidence can identify the Discord customer and Quest account, never the raw Token. Public `quest-new`
  must not identify the customer.
- `quest-new` shows no Quest ID, test state or internal sale state. Quest select copy remains type, Orbs, progress and
  price; expiry belongs on quote/review.
- Final Order DM uses one **รับรางวัลทั้งหมด** link to the first successful Quest and one **ดูประวัติ Quest ทั้งหมด**
  link to the history channel.
- Branding media is an image/GIF URL in v1. Do not invent a video subsystem.
- Runtime permission-drift detection and automatic repair are deliberately absent. Discord 403 creates/preserves an
  incident for manual Owner repair; it must not silently alter channel permissions.
- The Owner intentionally removed human-visibility/privacy preflight checks from backoffice setup and Payment Log
  delivery. `LOG_PAYMENTS` can contain a full voucher link; no runtime guard verifies who can see that channel.
  Do not reintroduce such a guard without a new Owner decision. This is a known Owner-accepted exposure risk.
- Legacy reference folders are local-only and excluded from the root import/test graph.

## 3. Architecture and state ownership

- Discord handlers validate untrusted input, acknowledge exactly once, reauthorize at each side effect and call a
  domain service. They must not write Wallet, Ledger, Payment, Order, Runner, Catalog, Review or Outbox state directly.
- Domain services own transactions, state transitions, idempotency, audit and outbox writes.
- Every aggregate transition uses its transition map, `state_version`, compare-and-swap, correlation context and
  required transition/audit evidence. Never overwrite a stale state.
- Financial operations use PostgreSQL `SERIALIZABLE` transactions with bounded whole-transaction retry. Queue/outbox
  acquisition uses `READ COMMITTED`, row locks and `FOR UPDATE SKIP LOCKED` where established.
- Never hold a database transaction over Discord, TrueMoney, Quest API, S3 or other external I/O.
- External mutations require durable intent/checkpoint before send and fresh verification afterward. A potentially
  sent mutation is never blindly retried.
- Worker commits require lease owner, fencing token and state version. A zero-row update or lost lease stops the old
  worker; a Runtime lease loss must mark not-ready, stop ingress/dequeue, clean up and terminate.
- PostgreSQL time governs money, lease, expiry, deadlines and retention. Node monotonic time measures latency only.
- Background Discord messages are projections delivered through Outbox/DLQ. Preserve coalescing, bounded retries and
  delivery evidence.
- Persistent components use opaque versioned IDs plus server-side actor/guild/channel/message/operation/expiry checks.
  A custom ID is routing data, never authorization.

## 4. Database, roles and migrations

- Never edit an applied migration; add the next zero-padded file in `migrations/`.
- Preserve migration checksums and synchronize enum/check constraints with JavaScript state maps.
- Breaking schema changes use Expand → Migrate → Contract. Do not add automatic down migrations.
- Production URLs must use TLS `sslmode=verify-full`. Keep Runtime and Migrator credentials separate.
- `DATABASE_DIRECT_URL` is for `questshop_migrator` during `npm run deploy`; `DATABASE_POOL_URL` is for
  `questshop_runtime` while `npm start` runs. They must not be the same role.
- Aiven/Admin owns role creation, membership, `CONNECT` and schema grants. Questshop migration syncs only objects owned
  by the effective migrator; it must not create roles, change membership or assume schema grant option.
- Runtime has no DDL. It must never receive `UPDATE`/`DELETE` on `wallet_transactions`, `admin_audit_logs` or
  `release_evidence`; retention uses the allowed security-definer functions.
- Object privilege synchronization runs after every migration loop, including `applied: 0`; a failed effective-grant
  validation is fail-closed and must not be papered over by changing role membership from application code.
- Never destroy/recreate a non-disposable database. `scripts/load-test.js` accepts only a database name containing
  `questshop_loadtest`.

## 5. Money, payment and credential invariants

- Reserved balance changes only through Reserve/Capture/Release domain paths.
- Voucher identity uses versioned HMAC and unique constraints. Receiver and Promotion are snapshotted at Top-up
  creation.
- `REDEEMED` and `CREDITED` differ. Recovery across their boundary must credit exactly once.
- Provider/schema/receiver/amount/currency uncertainty fails closed without credit. After a request may have been
  sent, verify or use Owner-only `AMBIGUOUS/MANUAL_REVIEW`.
- Over-limit vouchers credit the full amount actually received, record a warning and block more top-ups for that
  Bangkok day. Never confiscate excess funds.
- Financial/Audit DLQ can be replayed but never discarded.
- Never print, log, return, fixture, commit or paste a Bot/User token, cookie, session, voucher code/link, database
  URL, password, S3 credential, raw keyring or decrypted receiver value.
- The payment-log projection is the narrow product exception: it can render a full voucher link to `LOG_PAYMENTS`.
  Owner policy deliberately provides no automated human-visibility check; do not broaden the exception into generic
  logger/UI output.
- First-run setup may generate `STATUS_TOKEN`, Data encryption and Voucher HMAC keyrings once. Startup must never
  silently regenerate/replace them. Use AES-256-GCM with random nonce, versioned keyring and context-specific AAD.
- Admin has no credential decrypt/read route. Redact structured logs and string messages via the central logger.

## 6. Discord UX and operations

- Customer-specific Token, Wallet, selection, quote, top-up and error responses are Ephemeral.
- Use Thai customer copy, truthful progress and actionable recovery; do not expose raw domain enum values to customers.
- Store exact progress but edit History only when state, 25% bucket or Claim URL changes.
- One Quest announcement/history/job summary owns one message and edits it rather than spamming new messages.
- Respect Discord constraints: custom ID ≤100, button label ≤80, one select per Action Row, ≤5 buttons/row and ≤5 rows.
- Allow mentions deny-by-default. Treat component/modal/URL/Markdown/provider/raw metadata input as untrusted.
- Normal Feature gates default open at first install; they are internal incident brakes, not an Admin storefront
  checklist. Financial incidents close only related gates and preserve evidence. Owner recovery is contextual to the
  incident and never a global open/close menu.
- Setup is Owner-only. Re-running setup commands updates/moves the durable surface anchor; it must not create active
  duplicate panels.
- Bot Administrator is validated at startup/preflight. Backoffice channel privacy is Owner-managed by the accepted
  product policy; do not present an automated privacy check as protection.

## 7. Development and documentation workflow

Before editing, read relevant source/tests/docs and `git status`. Preserve unrelated dirty work, including the local
ZIP and legacy reference directories. Use `apply_patch` for manual edits; do not stage `.env`, dumps, backups, ZIPs,
credentials or user-owned files.

For source changes, run at minimum:

```bash
npm run check
npm run lint
TEST_DATABASE_URL=<disposable-postgresql-16-url> QUESTSHOP_ALLOW_TEST_DATABASE_RESET=true npm test
git diff --check
```

For money, migration, worker, Discord, security or recovery changes, add focused regression coverage and run the
full risk-appropriate suite. Release evidence additionally needs `npm run test:coverage`, `npm run load:test`,
`npm audit --audit-level=high`, Docker build and the live UAT checklist on one exact SHA.

When behavior, configuration, security or operations change, update `[Unreleased]` in `CHANGELOG.md` and keep
`README.md`, `SECURITY.md`, `.env.example`, runbooks and traceability aligned. Documentation must distinguish:

- commands that are safe/local versus commands that mutate deployment state;
- Runtime URL versus Direct/Migrator URL;
- source/test evidence versus live evidence;
- Owner-accepted risk versus an enforced control.

## 8. Git and publication

- Do not commit/push/open or update a PR/resolve threads/merge unless explicitly asked.
- Stage only named intended files; never use a broad stage command in a mixed worktree.
- Do not force-push, reset, checkout away changes, delete branches or use destructive Git commands without explicit
  scoped approval.
- Bind deployment/UAT evidence to the exact 40-character `GIT_SHA`; never reuse a passing check from another revision.
