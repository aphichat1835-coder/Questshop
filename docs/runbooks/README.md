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
| Permission drift | Disable exposed surface only | Owner reviews diff and explicitly repairs/validates |
| Discord outage / 429 | Retain outbox; obey Retry-After | Resume coalesced delivery after health recovers |
| Backup / restore failure | Block migrations/deploy | Repair storage/key/role, then complete a verified drill |
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
- A worker crash with an `IN_FLIGHT`, `ACCEPTED` or `UNCERTAIN` mutation enters Manual Review; fresh provider state is mandatory.
- Financial/Audit DLQ can be replayed but never discarded. Replay creates a new Outbox event and parent trace.
- Permission repair is never automatic. The Owner previews the surface/version, confirms, applies overwrites and revalidates.
- Database restore is disaster-only for production. Stop the store, preserve the failed database and reconcile every credit.
- Full voucher-link exposure requires disabling `LOG_PAYMENTS`, correcting access, preserving audit and reviewing viewers.
- A user block never confiscates Wallet credit and never changes an active job unless Admin performs a separate audited action.
