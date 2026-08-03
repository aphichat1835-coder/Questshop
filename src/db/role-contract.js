export async function validateRuntimeRole(client, { enforce = true } = {}) {
  const result = (await client.query(`SELECT current_user AS role,
    has_schema_privilege(current_user,'public','CREATE') AS can_create_schema_objects,
    has_table_privilege(current_user,'wallet_transactions','UPDATE') AS can_update_ledger,
    has_table_privilege(current_user,'wallet_transactions','DELETE') AS can_delete_ledger,
    has_table_privilege(current_user,'admin_audit_logs','UPDATE') AS can_update_admin_audit,
    has_table_privilege(current_user,'admin_audit_logs','DELETE') AS can_delete_admin_audit,
    has_function_privilege(current_user,
      'questshop_prune_wallet_ledger(timestamp with time zone,integer)','EXECUTE') AS can_prune_ledger,
    has_function_privilege(current_user,
      'questshop_prune_operational_details(timestamp with time zone,timestamp with time zone,integer)',
      'EXECUTE') AS can_prune_operational`)).rows[0];
  const violations = [];
  if (result.can_create_schema_objects) violations.push('runtime role can CREATE in public schema');
  if (result.can_update_ledger || result.can_delete_ledger) violations.push('runtime role can mutate immutable wallet ledger');
  if (result.can_update_admin_audit || result.can_delete_admin_audit) violations.push('runtime role can mutate immutable admin audit');
  if (!result.can_prune_ledger) violations.push('runtime role cannot execute controlled ledger retention function');
  if (!result.can_prune_operational) violations.push('runtime role cannot execute controlled operational retention function');
  if (enforce && violations.length) throw new Error(`PostgreSQL runtime role contract failed: ${violations.join('; ')}`);
  return { ...result, violations };
}
