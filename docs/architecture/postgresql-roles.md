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

- It first revokes every prior Runtime and `PUBLIC` default table/sequence privilege, then grants future tables only
  Runtime `SELECT` and future sequences only Runtime `USAGE, SELECT`. Therefore an `applied: 0` deployment repairs
  stale defaults from an earlier release instead of merely adding the desired privilege beside an old write grant.
- General tables receive Runtime `SELECT, INSERT, UPDATE, DELETE`; sequences receive `USAGE, SELECT`.
- `wallet_transactions`, `admin_audit_logs`, and append-only `release_evidence` receive only `SELECT, INSERT`.
- `schema_migrations` and `crypto_key_sentinels` are Runtime read-only.
- Future functions have `PUBLIC EXECUTE` removed. Current Migrator-owned `questshop_*` functions have `PUBLIC` and
  Runtime execute revoked, then Runtime is granted only
  `questshop_prune_wallet_ledger(timestamptz, integer)` and
  `questshop_prune_operational_details(timestamptz, timestamptz, integer)`.

The synchronizer performs catalog-derived identifier/signature quoting inside PostgreSQL itself, with the Runtime role
passed as a parameterized transaction-local setting. It does not compose DDL from application input, and does not
blanket revoke provider or extension functions. `release_evidence` is included as append-only because its migration
revokes update/delete and its domain path is idempotent insert/select only.

The read-only Runtime validator uses `has_*_privilege` so direct grants, `PUBLIC`, and inherited memberships all count.
It verifies schema use/no-create, ownership, table/sequence policy, protected tables, and the exact function allowlist.
A forbidden effective privilege is a provisioning violation: Questshop reports and fails; it never repairs role
membership from the Runtime process.

The PostgreSQL 16 integration suite uses distinct Admin, login-capable Migrator and Runtime roles. It proves that
object synchronization works with the effective Migrator role but without a schema grant option, rolls back all ACL
changes on a failed contract check, repairs stale defaults with `applied: 0`, and leaves provider-owned functions
unchanged. This is source/test evidence only; Aiven role provisioning and the removal of manual grants remain a live
deployment retest boundary.
