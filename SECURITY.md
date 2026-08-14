# Security Policy

Questshop handles Discord credentials, Quest account tokens, TrueMoney voucher information, Wallet credit,
PostgreSQL credentials, receiver information and encryption/HMAC key material. Treat this repository as a
financially and credential-sensitive system even while it remains pre-launch.

> [!IMPORTANT]
> Source/test evidence is not a live-security certificate. The supported development line is
> `[Unreleased]` / `0.1.x`, and its current completion label is **implemented-but-unverified** until the live
> checklist passes on one exact Git SHA.

## Supported versions

| Version | Security support |
|---|---|
| `[Unreleased]` / development `0.1.x` | Maintained while the Owner actively maintains this repository |
| Older snapshot, fork or unpinned deployment | No support guarantee |

## Reporting a vulnerability

Do not open a public Issue, Discussion, Pull Request comment or Discord public-channel post containing exploit
details or sensitive values.

1. Use [GitHub Private Vulnerability Reporting / Security Advisory](https://github.com/aphichat1835-coder/Questshop/security/advisories/new)
   if it is available for this repository.
2. Otherwise contact the Repository Owner privately first, without sending a real secret until a secure channel is
   confirmed.

Use redacted/fake data. A useful report contains:

- affected commit SHA/branch and environment type;
- smallest safe reproduction and expected versus actual result;
- affected route, worker, migration, adapter or state transition;
- non-secret Order/Top-up/Job IDs, support code or correlation ID;
- whether an external mutation may have occurred;
- containment suggestion, if known.

Do not redeem a real voucher, alter another person's Wallet, use somebody else's token, flood Discord/TrueMoney,
destroy data or access a live environment without Owner authorization. Use fake adapters and disposable databases
where possible. This repository has no bug bounty and grants no permission to test Discord or TrueMoney systems.

## Data that must not be disclosed

Never put these into Git, a test fixture, screenshot, log, ticket, PR, issue, Discord message or a copied terminal
output:

- Discord Bot token or Discord user token;
- cookie, session, OAuth, interaction or webhook token;
- `DATABASE_POOL_URL`, `DATABASE_DIRECT_URL`, database password or TLS private material;
- `STATUS_TOKEN`, Data encryption keyring, Voucher HMAC keyring or any other raw key JSON;
- S3 access/secret keys, decrypted dumps or decrypted receiver value;
- raw TrueMoney provider request/response that contains PII or credentials.

If a secret leaks, revoke/rotate it at the provider first. Then preserve only safe metadata needed for an incident.
Deleting a file from the latest commit does not remove a leaked value from Git history, logs, artifacts, shell history
or provider backups.

### Owner-accepted Payment Log exposure

The Owner deliberately chose to remove runtime human-visibility/privacy checks for backoffice surfaces. The
`LOG_PAYMENTS` projection can render a **full voucher link**, and the bot does not inspect channel viewers before
doing so. This is an accepted product risk, not a security control.

The exception is narrow: a full voucher link belongs only in the Payment Log projection. It must not appear in the
application logger, a customer-facing response, a generic Admin panel or another projection. The Owner is solely
responsible for Discord channel membership, access history and any exposure caused by configuring that channel
incorrectly.

## Security invariants enforced by the source

### Money and payment

- All money is integer satang; floating point is forbidden.
- Financial transactions use PostgreSQL `SERIALIZABLE`, row locks, bounded whole-transaction retries and idempotency.
- Wallet balances cannot become negative. Reserved balance changes only through Reserve/Capture/Release paths.
- Wallet Ledger and Admin audit are append-only. Corrections use compensating transactions with reason and audit.
- `REDEEMED` and `CREDITED` are distinct; recovery must credit a redeemed Top-up exactly once.
- Ambiguous payment is Owner-only Manual Review. A request that may have been sent is never blindly retried.
- Invalid provider schema, receiver, currency or amount fails closed without credit.
- Financial/Audit DLQ may be replayed but cannot be discarded.

### Credentials and cryptography

- Customer token lifecycle is receive → validate → encrypt → session/order use → delete after terminal work.
- Monitor credentials remain encrypted and have no Admin plaintext-read route.
- AES-256-GCM uses random 12-byte nonces, versioned keyrings and context-specific AAD.
- Voucher identity uses a versioned HMAC plus database uniqueness constraints.
- `npm run setup` can create `STATUS_TOKEN`, Data encryption and Voucher HMAC keyrings once; re-running it must not
  silently replace a durable value.
- Central redaction covers structured logger fields, strings and serialized errors. Do not bypass it by logging raw
  provider payloads or concatenating secrets into a message.

### PostgreSQL and deployment roles

- Production database URLs require `sslmode=verify-full`; `pg` receives explicit CA data with
  `rejectUnauthorized: true` when `DATABASE_SSL_CA_BASE64` is configured.
- `questshop_migrator` and `questshop_runtime` are separate roles. The Runtime role has no schema DDL capability.
- Runtime must not have effective `UPDATE`/`DELETE` permission on `wallet_transactions`, `admin_audit_logs` or
  `release_evidence`, including through `PUBLIC` or inherited membership.
- Deployment migration synchronizes object privileges and fails closed if the effective role contract is violated.
- Runtime validates the contract read-only; it does not repair roles, membership or schema privileges.

### Discord, workers and external mutations

- Ephemeral Discord responses are not authorization. Side effects reauthorize actor, Guild/channel/message context and
  durable state.
- Component IDs are opaque/versioned and bind to server-side sessions.
- Allowed mentions default to deny.
- External calls never run inside a database transaction. Each mutation has durable intent/checkpoint and fresh
  verification after send.
- Worker commits require lease owner, fencing token and state version. Lost ownership stops the stale worker.
- Runtime permission-drift monitoring/auto-repair is intentionally absent. Discord 403 produces an incident for
  manual Owner repair; the bot must not change Discord permissions itself.

## Required secure deployment practice

Before deployment, follow [README.md](README.md#รันบน-inwcloud--aiven) and keep these boundaries intact:

- inwcloud runs Node 22.x and its Environment Variables/secret store holds all secrets; never bake `.env` into an
  image or repository.
- `DATABASE_POOL_URL` is the Runtime URL; `DATABASE_DIRECT_URL` is the separate Migrator URL needed by
  `npm run deploy`.
- Set `GIT_SHA` to the full 40-character commit actually being deployed.
- Use `BACKUP_MODE=AIVEN_MANAGED` unless an intentional, fully provisioned Local S3 backup/restore design exists.
- Use `npm ci --omit=dev && npm run deploy && npm start` for the current inwcloud deployment path.
- A successful `Questshop ready` confirms only that this runtime started; normal store functions are enabled by
  installation, but it does not prove live payment/Quest behavior or complete Owner UAT.

## Priority areas for review

Report immediately if you find:

- a token, secret, database URL, full voucher link outside the accepted Payment Log path, or decrypted receiver value
  in output/history;
- forged/stale interaction/session authorization, customer/Admin privilege bypass or unsafe command routing;
- negative Wallet balance, duplicate credit, double Capture/Release, Ledger mismatch or editable audit evidence;
- voucher replay, HMAC bypass, Receiver/Promotion snapshot mismatch or post-send blind retry;
- active-account uniqueness, queue fairness, lease/fencing or restart-recovery bypass;
- SQL injection, migration checksum bypass, Runtime DDL/effective privilege escalation or disabled TLS verification;
- unbounded provider/Discord retry, message duplication, financial DLQ discard or unsafe URL/mention rendering;
- `/statusz` authorization bypass or secret/operational leakage.

## Known and accepted risks

- Discord user token/Self-bot behavior can violate Discord terms and affect the account.
- Direct TrueMoney integration has no guaranteed provider contract and v1 has no automated reconciliation.
- The system does not verify the buyer owns a submitted Quest account and records no consent record by Owner policy.
- A Quest account can be presented by another buyer after prior work is terminal, but never has overlapping active jobs.
- Customer-discovered Quest can be considered for that authenticated account even when no Monitor has tested it.
- There is no separate staging environment; pre-launch uses the production Guild/database with `PRELAUNCH=true`,
  which limits customer interactions to Owner/Admin without requiring normal capabilities to be manually opened.
- Aiven-managed backup/recovery is an external provider boundary; Questshop does not claim a local restore drill in that
  mode.
- Owner-selected `LOG_PAYMENTS` configuration can expose full voucher links because automated viewer checks were
  removed.

Acceptance of these risks never permits token theft, unauthorized access, payment manipulation or accidental public
secret disclosure.

## Incident response

Follow this sequence for every incident:

```text
Detect → Contain → Preserve evidence → Recover → Verify → Reopen → Post-incident review
```

- The system closes only the relevant internal gate/surface during an incident; preserve Ledger, attempts, leases,
  fencing and provider evidence. Owner recovery must use the incident-specific flow rather than a global gate panel.
- Do not auto-release or edit money records to hide a mismatch.
- Record incident ID, Git SHA, correlation IDs, timeline, actor, evidence hashes, decision and reopening approval—never
  raw secrets.
- Use [Emergency runbooks](docs/runbooks/README.md) for incident-specific authority and recovery rules.

## Disclosure and fix policy

- Give maintainers time to contain and fix an issue before public disclosure.
- Money, Token, external-mutation, migration or authorization fixes need regression coverage and a recovery/rollback
  review.
- A fix is not complete just because tests pass: check affected logs/artifacts/history, database state and the relevant
  live boundary.
- Release notes must describe required configuration/migration actions without publishing a usable exploit.
