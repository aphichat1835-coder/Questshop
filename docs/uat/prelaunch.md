# Pre-launch acceptance

Use [`evidence-template.md`](./evidence-template.md) to record every result
against one exact Git SHA.  Do not record any secret or full voucher URL there.

- Use one production bot/guild/database with `PRELAUNCH=true` and mark all work `PRELAUNCH`. This restricts
  customer routes to Owner/Admin; it does not require a manual global gate checklist.
- Run concurrent reserve/capture/release, duplicate voucher, payment crash boundaries, runner lease loss,
  restart recovery, Discord 403/404/429/5xx, and DLQ replay on the same Git SHA.
- Redeem a real low-value TrueMoney voucher; verify success, ambiguous handling and Owner-only resolution.
- Confirm the Aiven service is running, its provider Backup status is visible in Aiven Console, and record the
  Free-plan recovery limitation. Questshop does not run `pg_dump` or a `pg_restore` drill in Aiven-managed mode.
  This is a provider boundary, not evidence that Questshop independently verified a restore.
- Close the test round with compensating entries. Never delete financial or Admin audit.
- After closeout, set `PRELAUNCH=false` and verify normal routes. Only a scoped incident brake that is still
  closed needs a separate health/invariant check and Owner reopening approval.
- Do not call the release production-ready until live boundaries and automated gates pass on one SHA.
