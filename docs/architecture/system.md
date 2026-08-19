# System architecture

Discord interactions acknowledge first and call domain services. Domain services own state transitions,
transactions, idempotency, wallet locks and outbox writes. External providers are never called while a
database transaction is open. Workers acquire durable jobs with PostgreSQL leases and fencing tokens.

Money is integer satang (`BIGINT`). Confirmation moves available credit to per-item reservations. Verified
completion captures the full item snapshot price; definite failure releases it; ambiguity retains it for review.
Orders are aggregates calculated from item state. One account can have one active order globally.

## Persistent Discord storefront

`QUEST_AUTO` is a durable Discord surface, not a normal transient message. The renderer owns the fixed storefront
heading **Discord Quest • Auto**, the Owner-approved Thai description, the **เริ่มทำเควส** / **เติมเงิน** buttons,
and the current customer-facing price summary.

The price line is derived read-only from the active `TYPE` price rules for all four supported Quest task types.
When all configured prices are equal, the storefront renders one value such as `5 บาท`; when GAME and VIDEO differ,
it renders the minimum-to-maximum range such as `5-7 บาท`. If any supported TYPE price is missing, the storefront
fails closed to `ค่าบริการยังไม่พร้อม` instead of inventing a price.

The persistent storefront also carries one fixed Owner-approved MP4 asset at
`src/discord/assets/videoplayback.mp4`. Before the runtime uploads that file it verifies the exact size
`6,812,564` bytes, an MP4 `ftyp` container marker, and SHA-256
`0a09d0088a30cc90722af5c1602b4335853246a28ccd46d321cc7c5b64efa467`.
The media is bundled source, not a generic video subsystem or external URL dependency.

Surface reconciliation compares the stored anchor against the expected title/description/footer and the expected
video filename. A stale price, missing video, old video filename, deleted anchor or config-version drift is repaired
by editing/recovering the same durable surface. Reconciliation runs through the normal Maintenance worker, currently
on an approximately 60-second cadence, and setup/restart can also heal the surface. It must not spam a second active
Quest Auto panel.

If the MP4 bytes are intentionally changed in a future release, change the expected media filename/version as well
or explicitly clear the existing attachment during migration/UAT; Discord-side drift detection identifies the
existing attachment by filename, while local source integrity is enforced by size/hash.

PostgreSQL time controls money boundaries, expiry, lease ownership and retention. Application monotonic time
is used only for latency. Runtime supports schema/engine N and N-1; breaking state migrations require drain.
