# Pre-launch acceptance

Use `evidence-template.md` to record every result against one exact Git SHA. Never record raw tokens, database URLs,
keyrings or a full voucher URL in UAT evidence.

## Preconditions

- [ ] `PRELAUNCH=true`; customer routes are restricted to Owner/Admin for this round.
- [ ] inwcloud runs Node 22.x and the selected checkout matches the recorded `GIT_SHA` when Git metadata is available.
- [ ] `questshop_migrator` and `questshop_runtime` are different effective roles.
- [ ] Production DB URLs use `sslmode=verify-full`; Runtime has no DDL and protected append-only tables deny update/delete.
- [ ] Bot has Discord `Administrator`.
- [ ] Owner has manually configured backoffice channel privacy; no automated human-visibility guard is assumed.
- [ ] Receiver, Monitor and keyring health are valid; record versions/IDs only.
- [ ] `npm run check`, `npm run lint`, PostgreSQL-backed coverage/tests, load test, `npm audit --audit-level=high` and Docker build passed for this SHA.

## Quest Auto storefront UAT

- [ ] `/quest-auto` creates/updates exactly one durable storefront anchor.
- [ ] Embed title is **Discord Quest • Auto**.
- [ ] Description shows Discord Orbs and Discord Token guidance and the two expected buttons remain usable.
- [ ] The approved `quest-auto-demo.gif` animates **inside the Rich Embed** in Discord desktop.
- [ ] The same GIF animates inside the embed in Discord mobile.
- [ ] No standalone MP4/video block appears above the storefront.
- [ ] No customer-visible `Questshop Surface • QUEST_AUTO` footer remains.
- [ ] Deployed source asset corresponds to size `9,190,692` bytes and SHA-256
      `c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1`.
- [ ] With equal GAME/VIDEO pricing, storefront shows one amount (for example `5 บาท`).
- [ ] Change one category price so GAME/VIDEO differ; the same storefront message updates to a min-max range
      (for example `5-7 บาท`) within the Maintenance reconciliation window, currently approximately 60 seconds.
- [ ] Change the price back/equalize categories and verify the same message collapses back to one amount.
- [ ] Restart runtime and confirm no duplicate Quest Auto panel or duplicate GIF attachment appears.
- [ ] Remove/corrupt the expected GIF attachment in the test Guild and verify reconciliation repairs the same message.
- [ ] Confirm legacy Quest Auto messages with the old technical footer can be migrated without creating a duplicate anchor.
- [ ] Delete the Quest Auto message in the test Guild, rerun/reconcile, and verify exactly one replacement becomes authoritative.
- [ ] Simulate/fix Discord 403 without letting the bot modify channel permission overwrites automatically.

## Financial proof

- [ ] Real low-value TrueMoney success: `REDEEMED → CREDITED` exactly once.
- [ ] Submit the same voucher twice: one durable Top-up owner, no double credit.
- [ ] Provider timeout after possible send: `AMBIGUOUS`, no blind retry.
- [ ] Owner resolves ambiguous payment with audit.
- [ ] Multi-Quest order captures successful Items and releases definite failures without losing cents.
- [ ] Worker crash/restart around settlement produces no duplicate Ledger mutation.

Use masked voucher identity only. Full voucher links belong only in the validated `LOG_PAYMENTS` surface.

## Discord / Quest proof

- [ ] Mobile checkout over 25 Quest options: pagination, selection and quote work.
- [ ] Wrong-user, forged and expired components fail closed without side effects.
- [ ] Real supported Video Quest verifies progress and ends at manual claim URL only.
- [ ] Real supported Desktop Quest verifies progress and ends at manual claim URL only.
- [ ] Monitor-discovered Quest remains private until current-contract test pass or audited **ส่งเลย**.
- [ ] Customer-discovered public announcement does not identify the customer or raw Token.
- [ ] Discord 404/429/5xx behavior preserves surface/outbox contracts.

## Aiven / operations proof

- [ ] Aiven Console provider backup status and Free-plan recovery limitation are recorded.
- [ ] Runtime restart recovers leases, queue, Runner, Payment, Outbox and Review state.
- [ ] `/livez`, `/readyz` and authenticated `/statusz` behave as documented.
- [ ] External/Owner alert delivery is observed.
- [ ] Rollback rehearsal records app rollback or forward-fix decision without editing applied migrations.

## Closeout

- [ ] Run `CONFIRM_PRELAUNCH_CLOSEOUT=I_UNDERSTAND_COMPENSATING_TRANSACTIONS npm run prelaunch:closeout`.
- [ ] Record resulting release-evidence ID and confirm financial/Admin audit evidence was not deleted.
- [ ] Owner sets `PRELAUNCH=false` only after closeout and all required live rows pass/receive an approved forward-fix.

## Final decision

Status becomes `done` only when automated evidence and every applicable live boundary above pass on the same Git SHA.
Otherwise it remains **implemented-but-unverified**.
