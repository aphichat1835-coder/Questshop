# Questshop production evidence record

Copy this file for each pre-launch round. It records evidence; it does not replace database audit trails.
Never record raw tokens, voucher URLs, database URLs, cookies, passwords or encryption/HMAC keys.

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

Stop the round if app/migration/config deployment changes the Git SHA.

## Preconditions

- [ ] `PRELAUNCH=true`.
- [ ] Direct/Runtime Aiven URLs use distinct roles and `sslmode=verify-full`.
- [ ] Runtime has no schema DDL and protected append-only tables deny update/delete.
- [ ] Bot has Discord `Administrator`.
- [ ] Owner manually verified backoffice channel viewers/roles; no automated privacy guard is claimed.
- [ ] Receiver, Monitor and keyring health are valid; record version/ID only.
- [ ] check/lint/PostgreSQL-backed coverage/load/audit/Docker gates passed for this SHA.

## Quest Auto evidence

Expected source contract:

```text
Title    Discord Quest • Auto
Video    src/discord/assets/videoplayback.mp4
Size     6,812,564 bytes
SHA-256  0a09d0088a30cc90722af5c1602b4335853246a28ccd46d321cc7c5b64efa467
```

| Case | Discord Message ID / evidence | Expected outcome | Observed outcome | Owner approval |
|---|---|---|---|---|
| `/quest-auto` install/update | | one durable active anchor | | |
| Desktop video playback | | `videoplayback.mp4` plays correctly | | |
| Mobile video playback | | same uploaded video plays correctly | | |
| Equal GAME/VIDEO price | | one amount, e.g. `5 บาท` | | |
| Different GAME/VIDEO price | | min-max range, e.g. `5-7 บาท` | | |
| Price refresh timing | | same message updates within ~60s Maintenance window | | |
| Restart | | no duplicate anchor/video attachment | | |
| Legacy/missing video | | same anchor replaces stale attachment with `videoplayback.mp4` | | |
| Deleted anchor | | exactly one replacement becomes authoritative | | |
| Discord 403 | | incident/pointer preserved; no permission auto-repair | | |

Record only message/channel IDs and timestamps, never a Discord user token.

## Financial proof

| Case | Top-up / Order / Trace ID | Expected outcome | Observed outcome | Owner approval |
|---|---|---|---|---|
| Real low-value TrueMoney success | | `REDEEMED → CREDITED` exactly once | | |
| Same voucher submitted twice | | one durable Top-up owner | | |
| Provider timeout after possible send | | `AMBIGUOUS`, no blind retry | | |
| Owner resolves ambiguous payment | | Credit or Reject with audit | | |
| Five Quest items: 3 success / 2 failure | | 3 Capture + 2 Release | | |
| Worker crash / restart around settlement | | no duplicate Ledger mutation | | |

Use masked voucher identity only. Complete voucher link belongs only in the validated `LOG_PAYMENTS` surface.

## Discord and Quest proof

| Case | Evidence IDs | Expected outcome | Observed outcome | Approved by |
|---|---|---|---|---|
| Mobile checkout >25 options | | pagination/selection/quote works | | |
| Forged/wrong-user/expired component | | denied without side effect | | |
| Real Video Quest | | verify then manual claim URL only | | |
| Real Desktop Quest | | verify then manual claim URL only | | |
| Monitor-discovered Quest | | private until current-contract pass/override | | |
| customer `quest-new` | | public output hides customer source | | |
| Discord 404/429/5xx | | scoped retry/reconcile behavior | | |

For Quest runs, record Order Item ID, Job ID and shortened support code only.

## Aiven / operations proof

| Case | Backup / Incident / Trace ID | Expected outcome | Observed outcome | Owner approval |
|---|---|---|---|---|
| Aiven provider-managed backup | | Console status + plan limitation recorded | | |
| Runtime restart recovery | | leases/queue/payment/outbox/reviews recover | | |
| Health endpoints | | `/livez`, `/readyz`, authorized `/statusz` correct | | |
| Alert delivery | | Owner receives financial/infrastructure alert | | |
| Rollback rehearsal | | compatible app rollback or forward-fix decision | | |

## Closeout

- [ ] Run `CONFIRM_PRELAUNCH_CLOSEOUT=I_UNDERSTAND_COMPENSATING_TRANSACTIONS npm run prelaunch:closeout`.
- [ ] Record resulting `PRELAUNCH_CLOSEOUT` release-evidence ID.
- [ ] Confirm no financial/Admin audit evidence was deleted.
- [ ] Owner sets `PRELAUNCH=false` only after required rows are approved.

## Final decision

- [ ] Every applicable row passed or has an approved compensating/forward-fix record.
- [ ] Owner accepts residual risks.
- [ ] Status is `done` only for this exact Git SHA; otherwise **implemented-but-unverified**.
