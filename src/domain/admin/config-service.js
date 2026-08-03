import { v7 as uuidv7 } from 'uuid';
import { withTransaction } from '../../db/transaction.js';
import { appendAdminAudit } from './audit.js';
import { assertFeatureGate } from '../../config/feature-gates.js';
import { createHash } from 'node:crypto';
import { appendReleaseEvidence } from './release-evidence.js';

export async function updateFeatureGate({ gate, enabled, reason, expectedVersion, release = null }, context, options = {}) {
  assertFeatureGate(gate);
  if (!reason?.trim()) throw new TypeError('feature gate reason is required');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const before = (await client.query('SELECT * FROM feature_gates WHERE gate=$1 FOR UPDATE', [gate])).rows[0];
    if (!before || Number(before.version) !== Number(expectedVersion)) throw new Error('STALE_CONFIG');
    const after = (await client.query(`UPDATE feature_gates SET enabled=$2,reason=$3,actor_type=$4,
      actor_id=$5,trace_id=$6,version=version+1,updated_at=transaction_timestamp()
      WHERE gate=$1 AND version=$7 RETURNING *`, [gate, enabled, reason, context.actorType,
      context.actorId, context.traceId, expectedVersion])).rows[0];
    await appendAdminAudit(client, { action: 'FEATURE_GATE_CHANGE', targetType: 'FEATURE_GATE',
      targetId: gate, actorId: context.actorId, before, after, reason, context });
    if (release?.prelaunch) {
      await appendReleaseEvidence(client, {
        evidenceType: 'PRELAUNCH_GATE', subjectType: 'FEATURE_GATE', subjectId: `${gate}:v${after.version}`,
        release, evidence: { enabled, reason, beforeVersion: before.version, afterVersion: after.version },
      }, context);
    }
    return after;
  });
}

export async function setPriceRule({ ruleType, questId = null, taskType = null, amountCents,
  startsAt = null, endsAt = null, priority = 0, reason }, context, options = {}) {
  if (!['TEMPORARY', 'QUEST', 'TYPE', 'DEFAULT'].includes(ruleType)
    || BigInt(amountCents) <= 0n || !reason?.trim()
    || (startsAt && Number.isNaN(new Date(startsAt).getTime()))
    || (endsAt && Number.isNaN(new Date(endsAt).getTime()))
    || (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt))) throw new TypeError('invalid price rule');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const configVersion = Number((await client.query('SELECT COALESCE(max(version),1)::bigint AS value FROM config_versions')).rows[0].value);
    const id = uuidv7();
    const row = (await client.query(`INSERT INTO price_rules(id,rule_type,quest_id,task_type,
      amount_cents,priority,enabled,starts_at,ends_at,config_version,actor_id,trace_id)
      VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11) RETURNING *`, [id, ruleType,
      questId, taskType, amountCents, priority, startsAt, endsAt, configVersion, context.actorId, context.traceId])).rows[0];
    await appendAdminAudit(client, { action: 'PRICE_RULE_CREATE', targetType: 'PRICE_RULE', targetId: id,
      actorId: context.actorId, after: row, reason, context });
    return row;
  });
}

/**
 * Price rules are immutable amounts/snapshots.  Enabling and disabling is a
 * separate audited operation so an old quote can always name the exact rule
 * that produced it.
 */
export async function setPriceRuleEnabled({ priceRuleId, enabled, expectedVersion, reason }, context, options = {}) {
  if (!priceRuleId || typeof enabled !== 'boolean' || !Number.isInteger(Number(expectedVersion)) || !reason?.trim()) throw new TypeError('invalid price rule state');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const before = (await client.query('SELECT * FROM price_rules WHERE id=$1 FOR UPDATE', [priceRuleId])).rows[0];
    if (!before) throw new Error('PRICE_RULE_NOT_FOUND');
    if (Number(before.state_version) !== Number(expectedVersion)) throw new Error('STALE_CONFIG');
    if (before.enabled === enabled) return before;
    const after = (await client.query(`UPDATE price_rules SET enabled=$2,state_version=state_version+1
      WHERE id=$1 AND state_version=$3 RETURNING *`, [priceRuleId, enabled, expectedVersion])).rows[0];
    if (!after) throw new Error('STALE_CONFIG');
    await appendAdminAudit(client, { action: enabled ? 'PRICE_RULE_ENABLE' : 'PRICE_RULE_DISABLE',
      targetType: 'PRICE_RULE', targetId: priceRuleId, actorId: context.actorId, before, after, reason, context });
    return after;
  });
}

export async function createPromotion({ name, startsAt, endsAt, tiers,
  maxUsesPerUser = null, maxBonusPerDayCents = null, activate = false, reason }, context, options = {}) {
  if (!name?.trim() || !reason?.trim() || !Array.isArray(tiers) || !tiers.length) throw new TypeError('invalid promotion');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    if (activate) {
      const active = (await client.query("SELECT * FROM promotions WHERE state='ACTIVE' FOR UPDATE")).rows;
      for (const prior of active) {
        const disabled = (await client.query(`UPDATE promotions SET state='DISABLED',state_version=state_version+1
          WHERE id=$1 AND state_version=$2 RETURNING *`, [prior.id, prior.state_version])).rows[0];
        if (!disabled) throw new Error('STALE_CONFIG');
        await appendAdminAudit(client, { action: 'PROMOTION_DISABLE', targetType: 'PROMOTION', targetId: prior.id,
          actorId: context.actorId, before: prior, after: disabled,
          reason: `replaced by new promotion: ${reason}`, context });
      }
    }
    const id = uuidv7();
    const version = Number((await client.query('SELECT COALESCE(max(version),0)::bigint+1 AS value FROM promotions')).rows[0].value);
    const row = (await client.query(`INSERT INTO promotions(id,version,name,state,starts_at,ends_at,
      max_uses_per_user,max_bonus_per_day_cents,actor_id,trace_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [id, version, name.trim(),
      activate ? 'ACTIVE' : 'DRAFT', startsAt, endsAt, maxUsesPerUser, maxBonusPerDayCents,
      context.actorId, context.traceId])).rows[0];
    for (const tier of tiers) await client.query(`INSERT INTO promotion_tiers(id,promotion_id,
      minimum_amount_cents,basis_points) VALUES($1,$2,$3,$4)`,
    [uuidv7(), id, tier.minimumAmountCents, tier.basisPoints]);
    await appendAdminAudit(client, { action: 'PROMOTION_CREATE', targetType: 'PROMOTION', targetId: id,
      actorId: context.actorId, after: { ...row, tiers }, reason, context });
    return row;
  });
}

/**
 * A promotion version is never edited in place: its terms remain available to
 * already-submitted top-ups.  This state change only controls which campaign
 * future submissions may snapshot.
 */
export async function setPromotionState({ promotionId, state, expectedVersion, reason }, context, options = {}) {
  if (!promotionId || !['DRAFT', 'ACTIVE', 'DISABLED'].includes(state)
    || !Number.isInteger(Number(expectedVersion)) || !reason?.trim()) {
    throw new TypeError('invalid promotion state');
  }
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const before = (await client.query('SELECT * FROM promotions WHERE id=$1 FOR UPDATE', [promotionId])).rows[0];
    if (!before) throw new Error('PROMOTION_NOT_FOUND');
    if (Number(before.state_version) !== Number(expectedVersion)) throw new Error('STALE_CONFIG');
    if (before.state === 'EXPIRED') throw new Error('PROMOTION_EXPIRED');
    if (state === 'ACTIVE') {
      const valid = (await client.query('SELECT ends_at > clock_timestamp() AS usable FROM promotions WHERE id=$1', [promotionId])).rows[0];
      if (!valid?.usable) throw new Error('PROMOTION_EXPIRED');
    }

    // The store deliberately uses at most one campaign for each new top-up.
    // Capture and audit every displaced campaign rather than silently changing it.
    if (state === 'ACTIVE') {
      const displaced = (await client.query(`SELECT * FROM promotions
        WHERE state='ACTIVE' AND id<>$1 FOR UPDATE`, [promotionId])).rows;
      for (const prior of displaced) {
        const disabled = (await client.query(`UPDATE promotions SET state='DISABLED',state_version=state_version+1
          WHERE id=$1 AND state_version=$2 RETURNING *`, [prior.id, prior.state_version])).rows[0];
        if (!disabled) throw new Error('STALE_CONFIG');
        await appendAdminAudit(client, { action: 'PROMOTION_DISABLE', targetType: 'PROMOTION', targetId: prior.id,
          actorId: context.actorId, before: prior, after: disabled,
          reason: `replaced by promotion ${promotionId}: ${reason}`, context });
      }
    }
    if (before.state === state) return before;
    const after = (await client.query(`UPDATE promotions SET state=$2,state_version=state_version+1
      WHERE id=$1 AND state_version=$3 RETURNING *`, [promotionId, state, expectedVersion])).rows[0];
    if (!after) throw new Error('STALE_CONFIG');
    await appendAdminAudit(client, { action: `PROMOTION_${state}`, targetType: 'PROMOTION', targetId: promotionId,
      actorId: context.actorId, before, after, reason, context });
    return after;
  });
}

export async function updateRuntimeConfig({ patch, expectedVersion, reason }, context, options = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !reason?.trim()) throw new TypeError('invalid config update');
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const before = (await client.query('SELECT * FROM config_versions ORDER BY version DESC LIMIT 1 FOR UPDATE')).rows[0] ?? null;
    const version = Number(before?.version ?? 0);
    if (version !== Number(expectedVersion)) throw new Error('STALE_CONFIG');
    const payload = { ...before?.payload, ...patch };
    const nextVersion = version + 1;
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const row = (await client.query(`INSERT INTO config_versions(id,version,payload,payload_hash,
      actor_type,actor_id,trace_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [uuidv7(), nextVersion, payload, hash, context.actorType, context.actorId, context.traceId])).rows[0];
    await appendAdminAudit(client, { action: 'RUNTIME_CONFIG_CHANGE', targetType: 'CONFIG',
      targetId: nextVersion, actorId: context.actorId, before: before?.payload ?? {}, after: payload,
      reason, context });
    return row;
  });
}
