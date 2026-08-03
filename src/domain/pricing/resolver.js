export async function resolvePrice(client, { questId, taskType, at = null }) {
  const result = await client.query(`
    SELECT * FROM price_rules
    WHERE enabled = true
      AND (starts_at IS NULL OR starts_at <= COALESCE($3::timestamptz, clock_timestamp()))
      AND (ends_at IS NULL OR ends_at > COALESCE($3::timestamptz, clock_timestamp()))
      AND (
        (rule_type = 'TEMPORARY' AND (quest_id IS NULL OR quest_id = $1) AND (task_type IS NULL OR task_type = $2)) OR
        (rule_type = 'QUEST' AND quest_id = $1) OR
        (rule_type = 'TYPE' AND task_type = $2) OR
        rule_type = 'DEFAULT'
      )
    ORDER BY
      CASE rule_type WHEN 'TEMPORARY' THEN 1 WHEN 'QUEST' THEN 2 WHEN 'TYPE' THEN 3 ELSE 4 END,
      priority DESC,
      created_at DESC
    LIMIT 1
  `, [questId, taskType, at]);
  return result.rows[0] ?? null;
}

export async function minimumSellablePrice(client) {
  const result = await client.query(`
    SELECT min(resolved.amount_cents)::bigint AS amount_cents
    FROM quests q
    CROSS JOIN LATERAL (
      SELECT p.amount_cents
      FROM price_rules p
      WHERE p.enabled = true
        AND (p.starts_at IS NULL OR p.starts_at <= clock_timestamp())
        AND (p.ends_at IS NULL OR p.ends_at > clock_timestamp())
        AND (
          (p.rule_type = 'TEMPORARY' AND (p.quest_id IS NULL OR p.quest_id = q.quest_id)
            AND (p.task_type IS NULL OR p.task_type = q.task_type)) OR
          (p.rule_type = 'QUEST' AND p.quest_id = q.quest_id) OR
          (p.rule_type = 'TYPE' AND p.task_type = q.task_type) OR
          p.rule_type = 'DEFAULT'
        )
      ORDER BY CASE p.rule_type WHEN 'TEMPORARY' THEN 1 WHEN 'QUEST' THEN 2 WHEN 'TYPE' THEN 3 ELSE 4 END,
        p.priority DESC, p.created_at DESC LIMIT 1
    ) resolved
    WHERE q.sale_state = 'OPEN' AND q.expires_at > clock_timestamp()
  `);
  return result.rows[0]?.amount_cents ?? null;
}

export async function minimumConfiguredPrice(client) {
  const result = await client.query(`SELECT min(amount_cents)::bigint AS amount_cents
    FROM price_rules WHERE enabled=true
      AND (starts_at IS NULL OR starts_at<=clock_timestamp())
      AND (ends_at IS NULL OR ends_at>clock_timestamp())`);
  return result.rows[0]?.amount_cents ?? null;
}
