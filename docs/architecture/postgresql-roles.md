# PostgreSQL role contract

- `questshop_migrator`: direct connection, migration DDL only; never used by runtime workers.
- `questshop_runtime`: pooled connection, DML on application tables and sequence usage; no DDL. It must not
  receive `CREATE` on the application schema, but it requires `USAGE` so explicitly granted tables/functions
  remain addressable even when the provider revokes schema access from `PUBLIC`. It must not
  receive `UPDATE` or `DELETE` on `wallet_transactions` or `admin_audit_logs`.
  Grant only `EXECUTE` on `questshop_prune_wallet_ledger(timestamptz, integer)` and
  `questshop_prune_operational_details(timestamptz, timestamptz, integer)` for controlled retention;
  both `SECURITY DEFINER` functions cap each batch at 500, and Ledger pruning creates a checkpoint first.
- `questshop_backup` and `questshop_restore` are required only for the optional `BACKUP_MODE=LOCAL_S3`
  compatibility path. The default Aiven-managed deployment does not provide these credentials to Questshop.

Runtime and Migration URLs require TLS `verify-full`. Provision grants outside application migrations because managed
providers own role creation. Verify effective grants before opening any feature gate and after role rotation.
