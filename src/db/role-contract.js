export async function validateRuntimeRole(client, { enforce = true } = {}) {
  const result = (await client.query(`SELECT current_user AS role,
    has_schema_privilege(current_user,'public','USAGE') AS can_use_schema,
    has_schema_privilege(current_user,'public','CREATE') AS can_create_schema_objects,
    has_table_privilege(current_user,'wallet_transactions','UPDATE') AS can_update_ledger,
    has_table_privilege(current_user,'wallet_transactions','DELETE') AS can_delete_ledger,
    has_table_privilege(current_user,'admin_audit_logs','UPDATE') AS can_update_admin_audit,
    has_table_privilege(current_user,'admin_audit_logs','DELETE') AS can_delete_admin_audit,
    has_table_privilege(current_user,'quest_api_rate_limit_blocks','SELECT') AS can_read_quest_api_cooldown,
    has_table_privilege(current_user,'quest_api_rate_limit_blocks','INSERT') AS can_insert_quest_api_cooldown,
    has_table_privilege(current_user,'quest_api_rate_limit_blocks','UPDATE') AS can_update_quest_api_cooldown,
    has_table_privilege(current_user,'quest_api_rate_limit_blocks','DELETE') AS can_delete_quest_api_cooldown,
    has_function_privilege(current_user,
      'questshop_prune_wallet_ledger(timestamp with time zone,integer)','EXECUTE') AS can_prune_ledger,
    has_function_privilege(current_user,
      'questshop_prune_operational_details(timestamp with time zone,timestamp with time zone,integer)',
      'EXECUTE') AS can_prune_operational`)).rows[0];
  const violations = [];
  if (!result.can_use_schema) violations.push('runtime role cannot use public schema');
  if (result.can_create_schema_objects) violations.push('runtime role can CREATE in public schema');
  if (result.can_update_ledger || result.can_delete_ledger) violations.push('runtime role can mutate immutable wallet ledger');
  if (result.can_update_admin_audit || result.can_delete_admin_audit) violations.push('runtime role can mutate immutable admin audit');
  if (!result.can_read_quest_api_cooldown || !result.can_insert_quest_api_cooldown
    || !result.can_update_quest_api_cooldown || !result.can_delete_quest_api_cooldown) {
    violations.push('runtime role cannot maintain durable Quest API cooldowns');
  }
  if (!result.can_prune_ledger) violations.push('runtime role cannot execute controlled ledger retention function');
  if (!result.can_prune_operational) violations.push('runtime role cannot execute controlled operational retention function');
  if (enforce && violations.length) throw new Error(`PostgreSQL runtime role contract failed: ${violations.join('; ')}`);
  return { ...result, violations };
}
