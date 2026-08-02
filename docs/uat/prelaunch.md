# Pre-launch acceptance

- Use one production bot/guild/database with all customer gates closed and mark all work `PRELAUNCH`.
- Run concurrent reserve/capture/release, duplicate voucher, payment crash boundaries, runner lease loss,
  restart recovery, permission drift, Discord 403/404/429/5xx, and DLQ replay on the same Git SHA.
- Redeem a real low-value TrueMoney voucher; verify success, ambiguous handling and Owner-only resolution.
- Run `npm run backup` and `npm run restore:drill`; validate wallet checkpoints, reservations, payments, queue,
  outbox and encrypted credentials.
- Close the test round with compensating entries. Never delete financial or Admin audit.
- Enable gates individually: notifications, scanner, announcement, top-up, auto-credit, orders, runner,
  customer interactions, then store open. Record Owner approval and evidence for each gate.
- Do not call the release production-ready until live boundaries and automated gates pass on one SHA.
