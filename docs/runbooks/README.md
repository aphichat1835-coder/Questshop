# Emergency runbooks

Every incident follows: Detect → Contain → Preserve evidence → Recover → Verify → Reopen → Review.

| Incident | Immediate containment | Recovery authority |
|---|---|---|
| Ambiguous TrueMoney | The scoped payment circuit breaker protects auto-credit; preserve attempt/receiver/voucher evidence | Owner checks TrueMoney app, then Credit or Reject |
| Duplicate credit / ledger mismatch | Preserve evidence and let the financial incident brake stop affected intake; do not edit ledger | Owner uses compensating transaction after invariant audit |
| Database outage | Mark Not Ready; stop dequeue and financial actions | Restore connectivity, recover leases, verify ledger/checkpoints |
| Queue stuck / lease storm | Stop dispatch through the scoped incident path; snapshot jobs/leases | Expire stale leases with fencing, verify health, then Owner reopens only that incident control |
| Financial DLQ | Keep item reserved; never discard | Owner replay with new attempt and parent reference |
| Non-financial DLQ | Preserve delivery evidence | Owner replay or discard with reason/audit |
| Quest schema/executor failure | Pause affected Quest only | Pin compatible engine, retest, reopen sale |
| Monitor token invalid | Quarantine account immediately | Owner rotates credential, then uses **เช็คระบบ Token** to verify login and Quest-list access |
| Discord surface forbidden (403) | Preserve the outbox event and incident; do not change surface state automatically | Owner fixes the Discord channel permission manually, then replays the affected outbox event |
| Discord outage / 429 | Retain outbox; obey Retry-After | Resume coalesced delivery after health recovers |
| Discord interaction timeout / expired panel | Preserve Support code and exact Git SHA; do not retry a money action from the old control | Owner reruns the relevant setup command only for a confirmed old/deleted anchor, then starts the affected flow again from its current panel |
| Aiven database recovery | Keep store closed; preserve incident/ledger evidence | Owner restores or recovers through Aiven Console, then validates database/ledger before reopening |
| Secret compromise | Contain the affected integration; retain evidence | Activate new key version, resumable re-encryption, restore test |
| Deploy rollback | Maintenance and drain | Roll app only if schema compatible; otherwise forward-fix |
| Full voucher link exposure | Owner manually restricts the log channel and preserves audit | Rotate access, preserve audit and review viewers; no automatic privacy guard exists by Owner policy |
| Worker crash during mutation | Stop old fencing owner | Recover checkpoint, verify provider state before retry |
| Pre-launch closeout | Keep store closed | Compensate real financial tests; retain audit |
| Receiver rotation | Snapshot old receiver for pending jobs | New jobs use active version; old versions remain retained |
| User leaves guild | Do not confiscate wallet; active work continues | Admin may separately stop/release with audited action |

For every row, record incident ID, trace IDs, Git SHA, timeline, actor, evidence hashes, containment gates,
verification queries and reopening approval. Never paste tokens, cookies, database URLs or key material.

## Mandatory execution template

1. **Detect:** confirm the alert against PostgreSQL state and capture the short support/correlation code.
2. **Contain:** use the scoped incident control or surface action only. Financial invariants stop affected intake automatically; there is no general Admin gate menu.
3. **Preserve evidence:** export relevant immutable ledger IDs, attempts, fencing tokens, provider phases and hashes.
4. **Recover:** use the action in the table; never edit a ledger entry or retry an uncertain mutation blindly.
5. **Verify:** run the module invariant query, check Outbox/Review terminal state, and validate Discord projection.
6. **Reopen:** Owner records approval, reason and exact Git SHA before reopening only the affected incident control after its health/invariant check.
7. **Post-incident review:** document cause, blast radius, SLO impact, control failure and a regression test.

## Special decision rules

- Ambiguous TrueMoney remains reserved for Owner decision until the TrueMoney application provides evidence.
- A worker crash with an `IN_FLIGHT`, `ACCEPTED` or `UNCERTAIN` mutation is first reacquired for one fresh
  Quest-state verification. A proven completed result from the runner's own mutation is captured and moved to
  `READY_TO_CLAIM`; a completed Quest whose Item never started and has no runner proof is released as external
  completion. A proven absent `UNCERTAIN` mutation may receive one controlled retry. If the Item had already started
  but durable completion provenance is missing or contradictory, it enters Manual Review with money still Reserved
  instead of guessing Capture or Refund.
- A Monitor test whose Quest execution contract changed must not be force-published from an old alert.  Let the
  scanner create a current-contract batch, or investigate the new private alert; **ส่งเลย** is valid only for the
  same fingerprint.  A crash-recovered Monitor test verifies fresh state first and never treats enrollment alone as
  proof of test completion.
- Financial/Audit DLQ can be replayed but never discarded. Replay creates a new Outbox event and parent trace.
- Bot Administrator is validated at startup. Backoffice human visibility is Owner-managed and deliberately has no automated privacy preflight; runtime delivery failures are recorded as incidents and the bot never changes channel overwrites automatically.
- Database recovery is disaster-only for production. Stop the store, preserve the failed database and reconcile every credit.
- Aiven-managed mode does not create S3 artifacts or a Questshop restore drill. Record the Aiven Console recovery
  decision, the exact Git SHA and every ledger reconciliation before reopening. `backup:reconcile` applies only to
  the optional `LOCAL_S3` compatibility mode.
- Full voucher-link exposure requires Owner action to restrict the channel, preserve audit and review viewers; the bot does not enforce or repair channel privacy automatically.
- When Discord shows **Questshop ไม่ตอบสนอง**, keep the displayed Support code and check the matching structured
  interaction log first. A safe validation/business rejection must be an Ephemeral Thai response; an internal error
  must preserve its trace and never be solved by replaying a payment/refund confirmation blindly.
