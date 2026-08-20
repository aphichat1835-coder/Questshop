import { getRuntimePool } from '../db/pools.js';
import { DEFAULT_FEATURE_GATES } from './feature-gates.js';

export function sanitizeRuntimeConfigValues(payload = {}) {
  const values = { ...payload };
  // Human backoffice access is derived from Discord's Administrator
  // permission at each interaction boundary. Retire the old role-based
  // setting from every config snapshot the application reads or writes.
  delete values.adminRoleId;
  return values;
}

export async function loadRuntimeConfig(pool = getRuntimePool()) {
  const [gates, config, surfaces] = await Promise.all([
    pool.query('SELECT gate, enabled, version, reason FROM feature_gates'),
    pool.query('SELECT * FROM config_versions ORDER BY version DESC LIMIT 1'),
    pool.query('SELECT * FROM surfaces'),
  ]);
  return Object.freeze({
    version: Number(config.rows[0]?.version ?? 1),
    values: sanitizeRuntimeConfigValues(config.rows[0]?.payload),
    gates: Object.freeze({
      ...DEFAULT_FEATURE_GATES,
      ...Object.fromEntries(gates.rows.map((row) => [row.gate, row.enabled])),
    }),
    surfaces: Object.freeze(Object.fromEntries(surfaces.rows.map((row) => [row.surface_key, row]))),
  });
}

export async function setFeatureGate(client, { gate, enabled, reason, actor, context }) {
  const result = await client.query(`
    UPDATE feature_gates SET enabled = $2, reason = $3, actor_type = $4,
      actor_id = $5, trace_id = $6, version = version + 1,
      updated_at = transaction_timestamp()
    WHERE gate = $1 RETURNING *
  `, [gate, enabled, reason, actor.type, actor.id, context.traceId]);
  if (!result.rows[0]) throw new TypeError(`Unknown feature gate: ${gate}`);
  return result.rows[0];
}
