# State-machine contracts

The canonical allowed maps live in each domain `states.js`; SQL `CHECK` constraints define the value set.
Handlers cannot update business state directly. Every transition uses compare-and-swap, increments
`state_version`, and records trace/causation/actor evidence.

Top-up: `RECEIVED → VALIDATING → PAYMENT_QUEUED → PROCESSING`; success separates `REDEEMED` from
`CREDITED`. Uncertain mutations enter Owner-only manual review. Order item success ends at
`READY_TO_CLAIM`; released terminal states refund wallet credit. There is no automatic claim transition.

Outbox: `PENDING → LEASED → DELIVERED | RETRY_WAIT | DEAD_LETTER`. Financial and audit DLQ records
cannot be discarded.
