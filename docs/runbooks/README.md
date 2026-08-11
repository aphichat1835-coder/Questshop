# Emergency runbooks

Every incident follows: Detect → Contain → Preserve evidence → Recover → Verify → Reopen → Review.

| Incident | Immediate containment | Recovery authority |
|---|---|---|
| Ambiguous TrueMoney | Disable `AUTO_CREDIT_ENABLED`; preserve attempt/receiver/voucher evidence | Owner checks TrueMoney app, then Credit or Reject |
| Duplicate credit / ledger mismatch | Disable Top-up and Order gates; do not edit ledger | Owner uses compensating transaction after invariant audit |
| Database outage | Mark Not Ready; stop dequeue and financial actions | Restore connectivity, recover leases, verify ledger/checkpoints |
| Queue stuck / lease storm | Disable runner dispatch; snapshot jobs/leases | Expire stale leases with fencing, re-enable gradually |
| Financial DLQ | Keep item reserved; never discard | Owner replay with new attempt and parent reference |
| Non-financial DLQ | Preserve delivery evidence | Owner replay or discard with reason/audit |
| Quest schema/executor failure | Pause affected Quest only | Pin compatible engine, retest, reopen sale |
| Monitor token invalid | Quarantine account immediately | Owner rotates credential, then uses **เช็คระบบ Token** to verify login and Quest-list access |
| Discord surface forbidden (403) | Preserve the outbox event and incident; do not change surface state automatically | Owner fixes the Discord channel permission manually, then replays the affected outbox event |
| Discord outage / 429 | Retain outbox; obey Retry-After | Resume coalesced delivery after health recovers |
| Aiven database recovery | Keep store closed; preserve incident/ledger evidence | Owner restores or recovers through Aiven Console, then validates database/ledger before reopening |
| Secret compromise | Disable affected feature; retain evidence | Activate new key version, resumable re-encryption, restore test |
| Deploy rollback | Maintenance and drain | Roll app only if schema compatible; otherwise forward-fix |
| Full voucher link exposure | Disable payment log surface | Restrict permissions, rotate access, preserve audit |
| Worker crash during mutation | Stop old fencing owner | Recover checkpoint, verify provider state before retry |
| Pre-launch closeout | Keep store closed | Compensate real financial tests; retain audit |
| Receiver rotation | Snapshot old receiver for pending jobs | New jobs use active version; old versions remain retained |
| User blocked/leaves guild | Do not confiscate wallet; active work continues | Admin may separately stop/release with audited action |

For every row, record incident ID, trace IDs, Git SHA, timeline, actor, evidence hashes, containment gates,
verification queries and reopening approval. Never paste tokens, cookies, database URLs or key material.

## Mandatory execution template

1. **Detect:** confirm the alert against PostgreSQL state and capture the short support/correlation code.
2. **Contain:** close only the affected feature gate or surface. Financial invariants close auto-credit and order intake.
3. **Preserve evidence:** export relevant immutable ledger IDs, attempts, fencing tokens, provider phases and hashes.
4. **Recover:** use the action in the table; never edit a ledger entry or retry an uncertain mutation blindly.
5. **Verify:** run the module invariant query, check Outbox/Review terminal state, and validate Discord projection.
6. **Reopen:** Owner records approval, reason and exact Git SHA before reopening gates one at a time.
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
- Surface permissions are configured and checked as a one-time precondition during setup. Runtime delivery failures are recorded as incidents; the bot never changes channel overwrites automatically.
- Database recovery is disaster-only for production. Stop the store, preserve the failed database and reconcile every credit.
- Aiven-managed mode does not create S3 artifacts or a Questshop restore drill. Record the Aiven Console recovery
  decision, the exact Git SHA and every ledger reconciliation before reopening. `backup:reconcile` applies only to
  the optional `LOCAL_S3` compatibility mode.
- Full voucher-link exposure requires disabling `LOG_PAYMENTS`, correcting access, preserving audit and reviewing viewers.
- A user block never confiscates Wallet credit and never changes an active job unless Admin performs a separate audited action.
