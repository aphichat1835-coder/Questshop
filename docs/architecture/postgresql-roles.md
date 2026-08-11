# PostgreSQL role contract

Runtime and Migration URLs require TLS `verify-full`. Questshop validates that source URL policy before opening a
pool, then removes libpq SSL query parameters from the copy passed to `pg`; the pool always receives the explicit
verified CA object with `rejectUnauthorized: true`. This prevents `sslmode` in the URL from replacing the CA object.

## Aiven/Admin bootstrap — outside Questshop

The managed-provider administrator owns role creation, `CONNECT`, role membership and schema privileges:

- `questshop_migrator`: `USAGE, CREATE` on `public`, used only by the direct migration connection.
- `questshop_runtime`: `USAGE` on `public`, never `CREATE`, used only by the pooled runtime connection.
- `questshop_backup` and `questshop_restore` are required only for the optional `BACKUP_MODE=LOCAL_S3`
  compatibility path. The default Aiven-managed deployment does not provide these credentials to Questshop.

Questshop never creates roles, changes role membership, or grants/revokes schema privileges. If provider provisioning
does not meet this contract, deployment verification fails rather than attempting to expand the migrator's authority.

## Questshop migration-time object synchronization

After the migration advisory lock applies every pending SQL file, it opens one object-privilege transaction even when
`applied: 0`. The effective PostgreSQL `current_user` must differ from the non-empty Runtime role derived by the
deployment wrapper from `DATABASE_POOL_URL`; otherwise it fails closed.

For objects owned by that Migrator in `public`, synchronization sets defaults and repairs current objects:

- General tables receive Runtime `SELECT, INSERT, UPDATE, DELETE`; sequences receive `USAGE, SELECT`.
- `wallet_transactions`, `admin_audit_logs`, and append-only `release_evidence` receive only `SELECT, INSERT`.
- `schema_migrations` and `crypto_key_sentinels` are Runtime read-only.
- Future functions have `PUBLIC EXECUTE` removed. Current Migrator-owned `questshop_*` functions have `PUBLIC` and
  Runtime execute revoked, then Runtime is granted only
  `questshop_prune_wallet_ledger(timestamptz, integer)` and
  `questshop_prune_operational_details(timestamptz, timestamptz, integer)`.

The synchronizer obtains identifiers/signatures from PostgreSQL catalogs, quotes them safely, and does not blanket
revoke provider or extension functions. `release_evidence` is included as append-only because its migration revokes
update/delete and its domain path is idempotent insert/select only.

The read-only Runtime validator uses `has_*_privilege` so direct grants, `PUBLIC`, and inherited memberships all count.
It verifies schema use/no-create, ownership, table/sequence policy, protected tables, and the exact function allowlist.
A forbidden effective privilege is a provisioning violation: Questshop reports and fails; it never repairs role
membership from the Runtime process.
