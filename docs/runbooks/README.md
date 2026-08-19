# Emergency runbooks

Every incident follows:

```text
Detect → Contain → Preserve evidence → Recover → Verify → Reopen → Review
```

| Incident | Immediate containment | Recovery authority |
|---|---|---|
| Ambiguous TrueMoney | preserve attempt/receiver/voucher evidence; no blind retry | Owner checks provider evidence, then Credit or Reject |
| Duplicate credit / ledger mismatch | stop affected intake through scoped incident control; never edit ledger | Owner uses compensating transaction after invariant audit |
| Database outage | mark Not Ready; stop dequeue/financial actions | restore connectivity, recover leases, verify ledger/checkpoints |
| Queue stuck / lease storm | stop affected dispatch; preserve jobs/leases | recover stale leases with fencing, verify, reopen scoped control |
| Financial DLQ | keep evidence/reservation; never discard | Owner replays with parent reference |
| Non-financial DLQ | preserve delivery evidence | Owner replay/discard with reason/audit |
| Quest schema/executor failure | pause affected Quest | pin compatible engine/contract, retest, reopen sale |
| Monitor token invalid | quarantine account | Owner rotates credential and runs **เช็คระบบ Token** |
| Discord surface 403 | preserve authoritative pointer/outbox/incident | Owner fixes Discord permission manually |
| Discord outage / 429 | retain outbox; obey Retry-After | resume coalesced delivery after health recovery |
| Discord interaction timeout | preserve Support code and Git SHA | restart the current flow; never replay uncertain money action blindly |
| Quest Auto stale price | keep current anchor; do not create a second panel | verify active `TYPE` prices; allow Maintenance reconciliation or rerun `/quest-auto` |
| Quest Auto missing/old video | keep current anchor | verify source `videoplayback.mp4`, then rerun `/quest-auto` or allow reconciliation |
| Quest Auto media integrity failure | do not bypass hash/size check | restore exact Owner-uploaded file in deployed source and redeploy |
| Aiven recovery | keep store closed; preserve ledger/incident evidence | Owner recovers through Aiven Console and reconciles before reopening |
| Secret compromise | contain affected integration | rotate provider/key version and verify scoped recovery |
| Deploy rollback | maintenance/drain as required | roll app only when schema compatible, otherwise forward-fix |
| Full voucher link exposure | Owner restricts channel and preserves audit | review viewers/access; no automated privacy guard exists |
| Worker crash during mutation | stop stale fencing owner | verify durable checkpoint/provider state before retry |
| Pre-launch closeout | keep store closed | compensate real financial tests; retain audit |
| Receiver rotation | retain old snapshot for pending work | new work uses active receiver version |

## Quest Auto recovery details

### Expected source asset

```text
src/discord/assets/videoplayback.mp4
Size     6,812,564 bytes
SHA-256  0a09d0088a30cc90722af5c1602b4335853246a28ccd46d321cc7c5b64efa467
```

If `Bundled Quest Auto video failed integrity verification` appears:

1. confirm the deployed Git SHA is the intended revision;
2. confirm the file exists at the exact path above;
3. verify the file was not converted/re-encoded/truncated by a manual upload step;
4. redeploy the correct source;
5. do **not** remove the integrity check just to make startup/surface refresh pass.

### Stale price

The storefront reads active supported `TYPE` price rules. If the visible price is stale:

1. confirm all four supported task types have one active TYPE rule;
2. confirm `QUEST_AUTO` surface is ACTIVE and its Discord message still exists;
3. allow the Maintenance worker one cycle (approximately 60 seconds);
4. if needed, Owner reruns `/quest-auto` to force setup/update of the same anchor;
5. verify the same Discord message ID remains active and no duplicate panel was created.

### Stale/legacy video attachment

If the message still contains an old attachment filename such as `quest-auto-demo.mp4`, reconciliation/setup should
clear attachments and upload `videoplayback.mp4` on the same durable message. If the message already has an attachment
named `videoplayback.mp4`, runtime intentionally preserves it to avoid duplicate upload.

Therefore, if the Owner intentionally changes the video bytes in a future release, version/change the filename or add
an explicit attachment migration; otherwise Discord-side filename matching can preserve the older remote bytes.

## Mandatory execution template

1. **Detect:** confirm the alert/state and capture short Support/correlation code.
2. **Contain:** use the scoped incident/surface action only.
3. **Preserve evidence:** record immutable IDs, attempts, fences and hashes; never raw secrets.
4. **Recover:** follow the relevant row above; never edit historical money evidence or blindly retry an uncertain mutation.
5. **Verify:** check domain invariants, Outbox/Review state and Discord projection/surface.
6. **Reopen:** Owner records approval, reason and exact Git SHA for the affected control.
7. **Review:** document cause, blast radius, SLO impact and a regression test.

## Special decision rules

- A possibly-sent TrueMoney or Quest mutation is verified before retry.
- A proven Runner completion with durable provenance captures the reservation; contradictory/missing provenance remains Reserved for Review.
- Monitor evidence is valid only for the exact execution-contract fingerprint.
- Financial/Audit DLQ can be replayed but never discarded.
- Bot Administrator is validated at startup; backoffice human visibility is Owner-managed and has no automated privacy preflight.
- Aiven-managed mode does not create Questshop S3 backup artifacts or a local restore-drill claim.
- A Quest Auto presentation repair may edit/recover Discord surface content/media but must not mutate Wallet/Ledger/Payment/Order state.
