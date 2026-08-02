# PostgreSQL role contract

- `questshop_migrator`: direct connection, migration DDL only; never used by runtime workers.
- `questshop_runtime`: pooled connection, DML on application tables and sequence usage; no DDL. It must not
  receive `UPDATE` or `DELETE` on `wallet_transactions` or `admin_audit_logs`.
  Grant only `EXECUTE` on `questshop_prune_wallet_ledger(timestamptz, integer)` and
  `questshop_prune_operational_details(timestamptz, timestamptz, integer)` for controlled retention;
  both `SECURITY DEFINER` functions cap each batch at 500, and Ledger pruning creates a checkpoint first.
- `questshop_backup`: read-only access required by `pg_dump`, with no application writes.
- `questshop_restore`: direct administrative connection restricted to restore drills and disaster recovery.

All four URLs require TLS `verify-full`. Provision grants outside application migrations because managed
providers own role creation. Verify effective grants before opening any feature gate and after role rotation.
