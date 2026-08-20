# Questshop requirement traceability

This matrix separates implemented source controls from evidence that requires a controlled live environment.
Current status remains **implemented-but-unverified**.

| Requirement group | Primary implementation | Automated evidence | Live evidence still required |
|---|---|---|---|
| Node 22 ESM, setup, source SHA | `src/config`, setup/deploy scripts, bootstrap | env/setup/source-version tests | exact inwcloud checkout + restart |
| PostgreSQL TLS, roles, time | pools, migrations, role sync/validator | TLS + PostgreSQL 16 role tests | Aiven CA/role provisioning |
| State machines, CAS, correlation | domain `states.js`, transitions, sessions | state/concurrency/crash tests | production trace sampling |
| Wallet / immutable ledger | wallet domain, reservations, retention | debit/settlement/refund/checkpoint tests | Owner compensation sign-off |
| TrueMoney / voucher identity | TrueMoney adapter, payment service/worker | URL/schema/HMAC/ambiguity/replay/crash tests | real low-value + ambiguous UAT |
| Pricing / promotion | pricing resolver, Admin config service | exact-satang + category/promotion tests | Owner Admin pricing UAT |
| Quest Auto dynamic price | `configuredQuestPriceRange`, surface renderer/reconcile | equal/range/incomplete/stale-price tests | visible live price refresh |
| Quest Auto embedded GIF | `src/discord/assets/quest-auto-demo.gif`, `quest-auto-media.js` | exact size/GIF/hash + stale attachment/embed tests | desktop/mobile in-embed animation |
| Catalog / Monitor gate | catalog, discovery/test workers, contract pinning | Monitor-gate + retest + fingerprint tests | real metadata drift / Monitor UAT |
| Checkout / account lock | checkout domain + router | quote/session/account uniqueness tests | mobile checkout UAT |
| Fair queue / Runner | runner domain, leases, executors | fairness/fencing/retry/atomic settlement tests | real Video/Desktop Quest |
| Quest API recovery/rate limits | API client + shared coordinator | timeout/403/429/size/retry tests | real Discord REST behavior |
| Outbox / Discord delivery | outbox domain/workers, transport | coalescing/fencing/403/404/429/DLQ tests | live Discord fault UAT |
| Customer/Admin surfaces | commands/router/renderers/surfaces | route/session/payload/setup tests | Guild layout + mobile UI |
| Admin / Manual Review | Admin/review services | auth/review/adjustment tests | Owner workflow UAT |
| Backoffice privacy policy | startup/surface/outbox policy | no runtime human-visibility guard; Administrator startup test | Owner channel configuration |
| Health / alerts | health server, worker manager, alerts | `/statusz`, invariant/SLO tests | external alert delivery |
| Aiven backup policy | env/deployment policy | Aiven-managed skip/audit tests | Aiven Console recovery evidence |
| Deployment / rollback / CI | Dockerfile, workflow, deploy scripts | check/lint/coverage/load/audit/Docker | same-SHA deploy + rollback |
| Release acceptance | UAT docs + closeout | source gates only | all UAT rows on one SHA |

## Quest Auto trace detail

### Customer-facing renderer

`src/discord/renderers/surfaces.js`

- title is fixed to **Discord Quest • Auto**;
- approved description mentions Discord Orbs and Discord Token;
- `questAutoPriceRangeLabel()` renders one price or a min-max range;
- incomplete supported price configuration renders a not-ready price line;
- embed image is `attachment://quest-auto-demo.gif`;
- no customer-visible `Questshop Surface • QUEST_AUTO` footer is rendered.

### Pricing source

`src/domain/pricing/resolver.js`

- reads only active `TYPE` rules for the four supported task types;
- returns `{ minCents, maxCents }` only when all four task types are represented;
- uses integer satang / `BIGINT`, never float pricing.

### Durable surface reconciliation

`src/discord/surfaces/setup.js`

- keeps one durable `QUEST_AUTO` anchor;
- compares expected title/description, expected GIF attachment, embed-image presence and absence of the legacy visible footer;
- stale price or missing/legacy media causes an edit/recovery of the same message;
- stable nonce lookup is the primary invisible-anchor recovery path; footer lookup is migration fallback only;
- confirmed missing Discord message may be recreated; permission/network failures preserve the pointer and incident evidence;
- current Maintenance worker runs this reconciliation approximately every 60 seconds.

### Exact bundled media

`src/discord/surfaces/quest-auto-media.js` + `src/discord/assets/quest-auto-demo.gif`

```text
Size     9,190,692 bytes
SHA-256  c3af9ca54edfdc310e70c2fed9519fb2d587f77be7fddfec5dd3a275d2973ea1
```

Runtime verifies exact size, GIF signature and SHA-256 before upload. The attachment exists to back the Rich Embed image;
it is not intended as a standalone MP4/video block. Future intentional media replacement should version/change the
filename or include an explicit attachment migration.

## Completion labels

- `implemented-but-unverified`: source and automated evidence pass, but one or more live boundaries are missing.
- `done`: all automated and applicable live boundaries pass on the same exact Git SHA.
- `production-ready`: must not be used before the full live checklist and Owner acceptance are complete.
