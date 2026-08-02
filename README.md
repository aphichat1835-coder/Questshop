# Questshop

Questshop is a single-guild Discord storefront for automated Quest progress. It uses Node.js 22,
discord.js and PostgreSQL 16. Wallet, reservations, payment attempts, runner checkpoints, leases,
outbox delivery and reviews are durable PostgreSQL state.

The store starts with every feature gate disabled. Do not enable production gates until the
pre-launch checklist in `docs/uat/prelaunch.md` is complete on one Git SHA.

## Local verification

```bash
npm ci
npm run verify
```

Set `TEST_DATABASE_URL` to a disposable PostgreSQL 16 database to enable financial integration
tests. Legacy directories remain reference-only and are excluded from the new test/import graph.

## Safety boundaries

- No automatic reward claim API exists in `src/`.
- Discord user tokens are encrypted, order-scoped, never exposed to Admin, and deleted at terminal settlement.
- Feature gates default closed.
- TrueMoney auto-credit fails closed on ambiguous response, schema drift, missing receiver proof, or missing transaction ID.
- This integration uses Discord user tokens/self-bot behavior and may violate Discord terms or result in account restriction.
