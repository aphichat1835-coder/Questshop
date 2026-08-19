import { questPriceCategoryForTaskType } from './categories.js';

const SUPPORTED_QUEST_TASK_TYPES = Object.freeze([
  'PLAY_ON_DESKTOP',
  'PLAY_ON_DESKTOP_V2',
  'WATCH_VIDEO',
  'WATCH_VIDEO_ON_MOBILE',
]);

export async function resolvePrice(client, { taskType }) {
  if (!questPriceCategoryForTaskType(taskType)) return null;
  const result = await client.query(`
    SELECT * FROM price_rules
    WHERE enabled = true
      AND rule_type = 'TYPE'
      AND task_type = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [taskType]);
  return result.rows[0] ?? null;
}

export async function configuredQuestPriceRange(client) {
  const result = await client.query(`SELECT min(amount_cents)::bigint AS min_amount_cents,
      max(amount_cents)::bigint AS max_amount_cents
    FROM price_rules
    WHERE enabled=true AND rule_type='TYPE' AND task_type = ANY($1::text[])`, [SUPPORTED_QUEST_TASK_TYPES]);
  const row = result.rows[0];
  if (row?.min_amount_cents == null || row?.max_amount_cents == null) return null;
  return { minCents: BigInt(row.min_amount_cents), maxCents: BigInt(row.max_amount_cents) };
}

export async function minimumSellablePrice(client) {
  const result = await client.query(`
    SELECT min(resolved.amount_cents)::bigint AS amount_cents
    FROM quests q
    CROSS JOIN LATERAL (
      SELECT p.amount_cents
      FROM price_rules p
      WHERE p.enabled = true
        AND p.rule_type='TYPE' AND p.task_type=q.task_type
      ORDER BY p.created_at DESC LIMIT 1
    ) resolved
    WHERE q.sale_state = 'OPEN' AND q.expires_at > clock_timestamp()
      AND q.task_type IN ('PLAY_ON_DESKTOP','PLAY_ON_DESKTOP_V2','WATCH_VIDEO','WATCH_VIDEO_ON_MOBILE')
  `);
  return result.rows[0]?.amount_cents ?? null;
}

export async function minimumConfiguredPrice(client) {
  const result = await client.query(`SELECT min(amount_cents)::bigint AS amount_cents
    FROM price_rules WHERE enabled=true AND rule_type='TYPE'
      AND task_type IN ('PLAY_ON_DESKTOP','PLAY_ON_DESKTOP_V2','WATCH_VIDEO','WATCH_VIDEO_ON_MOBILE')`);
  return result.rows[0]?.amount_cents ?? null;
}
