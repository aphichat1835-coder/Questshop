# System architecture

Discord interactions acknowledge first and call domain services. Domain services own state transitions,
transactions, idempotency, wallet locks and outbox writes. External providers are never called while a
database transaction is open. Workers acquire durable jobs with PostgreSQL leases and fencing tokens.

Money is integer satang (`BIGINT`). Confirmation moves available credit to per-item reservations. Verified
completion captures the full item snapshot price; definite failure releases it; ambiguity retains it for review.
Orders are aggregates calculated from item state. One account can have one active order globally.

PostgreSQL time controls money boundaries, expiry, lease ownership and retention. Application monotonic time
is used only for latency. Runtime supports schema/engine N and N-1; breaking state migrations require drain.
