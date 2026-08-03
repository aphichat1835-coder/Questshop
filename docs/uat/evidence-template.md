# Questshop production evidence record

Copy this file for each pre-launch round.  It is a record of evidence, not a
replacement for the database audit trail.  Never put tokens, voucher URLs,
database URLs, cookies or encryption/HMAC keys in it.

## Release identity

| Field | Value |
|---|---|
| Git SHA (`git rev-parse HEAD`) | |
| App version | |
| Engine / executor / contract versions | |
| Schema version | |
| Environment | `PRELAUNCH` |
| Started at (UTC) | |
| Owner conducting UAT | |
| Guild ID | |

The Git SHA must be the same for every entry below.  Stop the round if an app,
migration or configuration deployment changes it.

## Preconditions

- [ ] Customer feature gates are closed; only Owner/Admin may use UAT routes.
- [ ] Managed PostgreSQL TLS uses `verify-full`; direct/runtime/backup/restore
      roles are distinct and runtime has no DDL privilege.
- [ ] Private log rooms deny `@everyone`; the bot has the expected permissions.
- [ ] Receiver version, monitor account and keyring health are valid; record
      version numbers only.
- [ ] `npm run verify`, `npm audit --audit-level=high`, Docker build and the
      fake-adapter load test passed for this SHA.

## Financial proof

| Case | Top-up / Order / Trace ID | Expected outcome | Observed outcome | Owner approval |
|---|---|---|---|---|
| Real low-value TrueMoney success | | `REDEEMED → CREDITED` exactly once | | |
| Same voucher submitted twice | | one durable top-up owner | | |
| Provider timeout after possible send | | `AMBIGUOUS`, no blind retry | | |
| Owner resolves ambiguous payment | | Credit or Reject with audit | | |
| Five Quest items: 3 success / 2 failure | | 3 Capture + 2 Release | | |
| Worker crash / restart around settlement | | no duplicate ledger change | | |

Record only masked voucher identifiers and database IDs.  The complete voucher
link belongs exclusively in the validated `log-payments` surface.

## Discord and Quest proof

| Case | Evidence IDs | Expected outcome | Observed outcome | Approved by |
|---|---|---|---|---|
| `/quest-auto` update/move and restart | | exactly one live anchor | | |
| Mobile checkout over 25 Quest options | | pagination/selection/quote works | | |
| Forged, wrong-user and expired component | | denied without side effect | | |
| Real supported video Quest | | verify then manual URL claim only | | |
| Real supported desktop Quest | | verify then manual URL claim only | | |
| `quest-new` discovery | | announcement hides customer source | | |
| Discord 403/404/429/5xx | | scoped surface/DLQ/retry behavior | | |
| Surface setup permissions | | setup rejects missing/private-room access | | |

For every Quest run, record the Order Item ID, Job ID and shortened support
code.  Do not record a Discord user token.

## Backup, restore and operations proof

| Case | Backup / Incident / Trace ID | Expected outcome | Observed outcome | Owner approval |
|---|---|---|---|---|
| Encrypted S3 backup | | upload + manifest verification | | |
| Restore drill to temporary managed DB | | schema/ledger/reservation/payment/queue/outbox/crypto checks pass | | |
| Runtime restart recovery | | leases, queue, runner, payment, outbox and reviews recover | | |
| Alert delivery | | financial and infrastructure alert reaches Owner | | |
| Rollback rehearsal | | app rollback or forward-fix decision recorded | | |

## Closeout and gate opening

- [ ] Run `CONFIRM_PRELAUNCH_CLOSEOUT=I_UNDERSTAND_COMPENSATING_TRANSACTIONS npm run prelaunch:closeout`.
- [ ] Record the resulting `PRELAUNCH_CLOSEOUT` release-evidence ID and confirm
      that no financial/admin audit was deleted.
- [ ] Owner approves each gate in this order, with its `PRELAUNCH_GATE`
      evidence ID: notifications → scanner → announcement → top-up →
      auto-credit → orders → runner → customer interactions → store open.

| Gate | Evidence ID | Opened at (UTC) | Owner | Rollback condition |
|---|---|---|---|---|
| `NOTIFICATIONS_ENABLED` | | | | |
| `QUEST_SCANNER_ENABLED` | | | | |
| `QUEST_ANNOUNCEMENT_ENABLED` | | | | |
| `TOPUP_ACCEPTING` | | | | |
| `AUTO_CREDIT_ENABLED` | | | | |
| `ORDER_ACCEPTING` | | | | |
| `RUNNER_DISPATCH_ENABLED` | | | | |
| `CUSTOMER_INTERACTIONS_ENABLED` | | | | |
| `STORE_OPEN` | | | | |

## Final decision

- [ ] All rows are passed or have an approved compensating/forward-fix record.
- [ ] Owner accepts the residual risks explicitly listed in the Final
      Decision-Complete plan.
- [ ] Status is `done` only after the evidence is stored for this exact SHA;
      otherwise the status remains `implemented-but-unverified`.
