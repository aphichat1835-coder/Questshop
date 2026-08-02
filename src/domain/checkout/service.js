import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { encryptSecret, decryptSecret } from '../../adapters/crypto/keyring.js';
import { withTransaction } from '../../db/transaction.js';
import { QuestshopError, AuthorizationError } from '../../shared/errors.js';
import { sumCents } from '../../shared/money.js';
import { createQuestApiClient, profileFromEnv } from '../../quest-engine/api/client.js';
import { ingestDiscovery, resolveSaleEligibility } from '../catalog/service.js';
import { resolvePrice } from '../pricing/resolver.js';
import { evaluateExpiryAdmission } from '../catalog/expiry.js';
import { enqueueProjection } from '../outbox/service.js';
import { recordTransition } from '../shared/transition.js';
import { reserveOrderItemsInTransaction } from '../wallet/service.js';
import {
  ENGINE_VERSION,
  EXECUTOR_VERSION,
  QUEST_CONTRACT_VERSION,
  RUNNER_STATE_SCHEMA_VERSION,
} from '../../config/versions.js';

const SESSION_TTL_MINUTES = 15;
const PREFLIGHT_TTL_SECONDS = 30;

function lineId() {
  return randomBytes(9).toString('base64url');
}
function selectionHash(items, configVersion) {
  const canonical = items.map((item) => `${item.line_id}:${item.quest_id}:${item.price_cents}:${item.price_rule_id}`)
    .sort().join('|');
  return createHash('sha256').update(`${configVersion}|${canonical}`).digest('hex');
}

function avatarUrl(profile) {
  if (!profile?.id || !profile?.avatar) return null;
  const extension = profile.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.${extension}?size=256`;
}

async function activeConfigVersion(client) {
  return Number((await client.query(
    'SELECT COALESCE(MAX(version), 1)::bigint AS version FROM config_versions',
  )).rows[0].version);
}

export async function createSession({
  discordUserId,
  guildId,
  channelId,
  messageId,
  token,
  env,
  runnerConcurrency = env.RUNNER_CONCURRENCY,
}, context, options = {}) {
  const apiFactory = options.questApiFactory ?? createQuestApiClient;
  const api = apiFactory({ token, profile: profileFromEnv(env) });
  const [profile, quests] = await Promise.all([
    api.fetchCurrentUser(),
    api.fetchQuests(),
  ]);
  if (!profile?.id) throw new QuestshopError('TOKEN_PROFILE_INVALID', 'ไม่สามารถตรวจบัญชี Discord ได้');
  for (const quest of quests) {
    await ingestDiscovery({
      normalized: quest,
      source: 'CUSTOMER_CHECKOUT',
      runnerConcurrency,
    }, context, options);
  }
  const candidates = [];
  for (const quest of quests) {
    if (quest.completed) continue;
    const eligibility = await resolveSaleEligibility({
      questId: quest.id,
      progressActual: quest.progress,
      runnerConcurrency,
    }, context, options);
    if (eligibility.eligible) candidates.push({ quest, eligibility });
  }

  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const sessionId = uuidv7();
    const configVersion = await activeConfigVersion(client);
    const encrypted = encryptSecret(token, env.DATA_ENCRYPTION_KEYS_JSON, `checkout:${sessionId}:${guildId}`);
    const session = (await client.query(`
      INSERT INTO interaction_sessions(
        id, actor_id, guild_id, channel_id, message_id, operation,
        config_version, payload, expires_at
      ) VALUES ($1,$2,$3,$4,$5,'CHECKOUT',$6,$7,
        transaction_timestamp() + interval '${SESSION_TTL_MINUTES} minutes') RETURNING *
    `, [sessionId, discordUserId, guildId, channelId, messageId, configVersion, {
      accountId: String(profile.id),
      username: profile.global_name ?? profile.username ?? String(profile.id),
      avatarUrl: avatarUrl(profile),
    }])).rows[0];
    await client.query(`
      INSERT INTO checkout_credentials(
        session_id, account_id, key_version, nonce, ciphertext, auth_tag
      ) VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      sessionId, String(profile.id), encrypted.keyVersion,
      encrypted.nonce, encrypted.ciphertext, encrypted.authTag,
    ]);
    for (const { quest, eligibility } of candidates) {
      await client.query(`
        INSERT INTO checkout_quest_options(
          id, session_id, line_id, quest_id, quest_name, task_type,
          price_cents, price_rule_id, metadata_revision, deadline_at, progress_actual
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [
        uuidv7(), sessionId, lineId(), quest.id, quest.name, quest.eventName,
        eligibility.price.amount_cents, eligibility.price.id,
        eligibility.quest.current_metadata_revision, eligibility.quest.expires_at, quest.progress,
      ]);
    }
    return { session, profile, optionsCount: candidates.length };
  });
}

async function lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId = null,
  messageId = null }) {
  const session = (await client.query(`
    SELECT *, expires_at > clock_timestamp() AS is_fresh
    FROM interaction_sessions WHERE id = $1 FOR UPDATE
  `, [sessionId])).rows[0];
  if (session?.state !== 'ACTIVE' || !session.is_fresh) {
    throw new QuestshopError('SESSION_EXPIRED', 'เซสชันหมดอายุ กรุณาเริ่มใหม่');
  }
  if (session.actor_id !== actorId || session.guild_id !== guildId) {
    throw new AuthorizationError('เซสชันนี้เป็นของผู้ใช้อื่น');
  }
  if (channelId && session.channel_id !== channelId) {
    throw new AuthorizationError('เซสชันนี้ถูกเรียกจากห้องอื่น');
  }
  if (messageId && session.message_id && session.message_id !== messageId) {
    throw new AuthorizationError('เซสชันนี้ถูกเรียกจากข้อความอื่น');
  }
  return session;
}

export async function updateSelection({ sessionId, actorId, guildId, channelId = null,
  messageId = null, lineIds, selected }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const session = await lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId, messageId });
    const currentConfigVersion = await activeConfigVersion(client);
    if (currentConfigVersion !== Number(session.config_version)) {
      throw new QuestshopError('QUOTE_EXPIRED', 'การตั้งค่าร้านเปลี่ยนไป กรุณาเริ่ม Quote ใหม่');
    }
    const result = await client.query(`
      UPDATE checkout_quest_options SET selected = $3
      WHERE session_id = $1 AND line_id = ANY($2::text[]) RETURNING *
    `, [sessionId, lineIds, selected]);
    await client.query(`
      UPDATE interaction_sessions SET state_version = state_version + 1,
        updated_at = transaction_timestamp() WHERE id = $1
    `, [sessionId]);
    return { session, changed: result.rowCount };
  });
}

export async function getSelectionPage({ sessionId, actorId, guildId, channelId = null,
  messageId = null, direction = 0 }, _context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const session = await lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId, messageId });
    const count = Number((await client.query(
      'SELECT count(*)::integer AS value FROM checkout_quest_options WHERE session_id = $1',
      [sessionId],
    )).rows[0].value);
    const pages = Math.max(1, Math.ceil(count / 25));
    const oldPage = Number(session.payload?.page ?? 0);
    const page = Math.max(0, Math.min(pages - 1, oldPage + direction));
    if (page !== oldPage) {
      await client.query(`
        UPDATE interaction_sessions SET payload = jsonb_set(payload, '{page}', to_jsonb($2::integer)),
          state_version = state_version + 1, updated_at = transaction_timestamp()
        WHERE id = $1
      `, [sessionId, page]);
    }
    const rows = (await client.query(`
      SELECT line_id, quest_id, quest_name, task_type, price_cents, selected
      FROM checkout_quest_options WHERE session_id = $1
      ORDER BY created_at, id OFFSET $2 LIMIT 25
    `, [sessionId, page * 25])).rows;
    return { session: { ...session, payload: { ...session.payload, page } }, rows, page, pages, count };
  });
}

export async function selectAll({ sessionId, actorId, guildId, channelId = null,
  messageId = null }, context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const session = await lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId, messageId });
    const result = await client.query(`
      UPDATE checkout_quest_options SET selected = true WHERE session_id = $1 RETURNING id
    `, [sessionId]);
    return { session, changed: result.rowCount };
  });
}

export async function buildQuote({ sessionId, actorId, guildId, channelId = null,
  messageId = null, runnerConcurrency = 3 }, _context, options = {}) {
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const session = await lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId, messageId });
    const items = (await client.query(`
      SELECT * FROM checkout_quest_options
      WHERE session_id = $1 AND selected = true ORDER BY created_at, id
    `, [sessionId])).rows;
    if (!items.length) throw new QuestshopError('NO_QUEST_SELECTED', 'กรุณาเลือก Quest อย่างน้อยหนึ่งรายการ');
    for (const item of items) {
      const quest = (await client.query('SELECT * FROM quests WHERE quest_id=$1 FOR SHARE', [item.quest_id])).rows[0];
      if (quest?.sale_state !== 'OPEN' || quest.analysis_state !== 'SUPPORTED') {
        throw new QuestshopError('QUEST_NOT_FOR_SALE', `Quest ${item.quest_name} ไม่เปิดขายแล้ว`);
      }
      const price = await resolvePrice(client, { questId: quest.quest_id, taskType: quest.task_type });
      if (!price || price.id !== item.price_rule_id || BigInt(price.amount_cents) !== BigInt(item.price_cents)) {
        throw new QuestshopError('QUOTE_EXPIRED', 'ราคามีการเปลี่ยนแปลง กรุณาเริ่ม Quote ใหม่');
      }
      const expiry = await evaluateExpiryAdmission(client, { quest: { ...quest,
        progress_actual: item.progress_actual }, runnerConcurrency });
      if (!expiry.eligible) throw new QuestshopError('QUEST_INSUFFICIENT_TIME',
        `เวลา Quest ${item.quest_name} ไม่เพียงพอ`);
    }
    const quoteHash = selectionHash(items, session.config_version);
    const updated = (await client.query(`UPDATE interaction_sessions SET
      payload=payload||jsonb_build_object('quoteHash',$2::text,'quotedAt',transaction_timestamp()),
      state_version=state_version+1,updated_at=transaction_timestamp() WHERE id=$1 RETURNING *`,
    [sessionId, quoteHash])).rows[0];
    return { session: updated, items, quoteHash, totalCents: sumCents(items.map((item) => item.price_cents)) };
  });
}

async function loadPreflight({ sessionId, actorId, guildId, channelId, messageId, env }, options) {
  const snapshot = await withTransaction({ ...options, isolation: 'READ COMMITTED', maxAttempts: 1 }, async (client) => {
    const session = await lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId, messageId });
    const credential = (await client.query(`
      SELECT * FROM checkout_credentials WHERE session_id = $1
    `, [sessionId])).rows[0];
    const items = (await client.query(`
      SELECT * FROM checkout_quest_options WHERE session_id = $1 AND selected = true
      ORDER BY created_at, id
    `, [sessionId])).rows;
    const dbNow = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now;
    return { session, credential, items, dbNow };
  });
  if (!snapshot.items.length) throw new QuestshopError('NO_QUEST_SELECTED', 'กรุณาเลือก Quest อย่างน้อยหนึ่งรายการ');
  const token = decryptSecret({
    keyVersion: snapshot.credential.key_version,
    nonce: snapshot.credential.nonce,
    ciphertext: snapshot.credential.ciphertext,
    authTag: snapshot.credential.auth_tag,
  }, env.DATA_ENCRYPTION_KEYS_JSON, `checkout:${sessionId}:${guildId}`);
  const apiFactory = options.questApiFactory ?? createQuestApiClient;
  const api = apiFactory({ token, profile: profileFromEnv(env) });
  const [profile, quests] = await Promise.all([api.fetchCurrentUser(), api.fetchQuests()]);
  if (String(profile.id) !== snapshot.credential.account_id) {
    throw new QuestshopError('TOKEN_ACCOUNT_CHANGED', 'Token ไม่ตรงกับบัญชีที่ตรวจครั้งแรก');
  }
  return { ...snapshot, token, profile, quests };
}

async function validateConfirmationSession(client, sessionInput, preflight) {
  const { sessionId, actorId, guildId, channelId, messageId } = sessionInput;
  const session = await lockAuthorizedSession(client, { sessionId, actorId, guildId, channelId, messageId });
    const currentConfigVersion = await activeConfigVersion(client);
    if (currentConfigVersion !== Number(session.config_version)) {
      throw new QuestshopError('QUOTE_EXPIRED', 'การตั้งค่าร้านเปลี่ยนไป กรุณาเริ่ม Quote ใหม่');
    }
    const freshEnough = (await client.query(`
      SELECT $1::timestamptz >= clock_timestamp() - interval '${PREFLIGHT_TTL_SECONDS} seconds' AS ok
    `, [preflight.dbNow])).rows[0].ok;
    if (!freshEnough) throw new QuestshopError('PREFLIGHT_EXPIRED', 'การตรวจบัญชีหมดอายุ กรุณายืนยันใหม่');
    const blocked = (await client.query(`
      SELECT 1 FROM blocklist_entries
      WHERE discord_user_id = $1 AND block_type = 'ORDER_BLOCKED' AND revoked_at IS NULL
        AND starts_at <= clock_timestamp() AND (expires_at IS NULL OR expires_at > clock_timestamp())
    `, [actorId])).rowCount > 0;
    if (blocked) throw new QuestshopError('ORDER_BLOCKED', 'บัญชีนี้ถูกระงับการสั่งทำ Quest');
    const queueCount = Number((await client.query(`
      SELECT count(*)::integer AS count FROM runner_jobs
      WHERE state IN ('QUEUED','LEASED','RUNNING','WAITING_RATE_LIMIT','WAITING_RETRY')
    `)).rows[0].count);
  if (queueCount >= 500) throw new QuestshopError('QUEUE_FULL', 'คิวงานเต็ม กรุณาลองใหม่ภายหลัง');
  const selected = (await client.query(`
      SELECT * FROM checkout_quest_options WHERE session_id = $1 AND selected = true
      ORDER BY created_at, id FOR UPDATE
    `, [sessionId])).rows;
    if (!selected.length) throw new QuestshopError('NO_QUEST_SELECTED', 'กรุณาเลือก Quest');
    if (!session.payload?.quoteHash
      || session.payload.quoteHash !== selectionHash(selected, session.config_version)) {
      throw new QuestshopError('QUOTE_EXPIRED', 'รายการที่เลือกเปลี่ยนไป กรุณาตรวจ Quote ใหม่');
  }
  return { session, selected };
}

async function validateSelectedOptions(client, selected, freshById, runnerConcurrency) {
  const validated = [];
  for (const option of selected) {
      const fresh = freshById.get(option.quest_id);
      if (!fresh || fresh.completed) {
        throw new QuestshopError('QUEST_EXTERNALLY_COMPLETED', `Quest ${option.quest_name} ทำเสร็จจากที่อื่นแล้ว`);
      }
      const quest = (await client.query(
        'SELECT * FROM quests WHERE quest_id = $1 FOR SHARE', [option.quest_id],
      )).rows[0];
      if (quest?.sale_state !== 'OPEN' || quest.analysis_state !== 'SUPPORTED') {
        throw new QuestshopError('QUEST_NOT_FOR_SALE', `Quest ${option.quest_name} ไม่เปิดขายแล้ว`);
      }
      const price = await resolvePrice(client, { questId: quest.quest_id, taskType: quest.task_type });
      if (!price || BigInt(price.amount_cents) !== BigInt(option.price_cents) || price.id !== option.price_rule_id) {
        throw new QuestshopError('QUOTE_EXPIRED', 'ราคามีการเปลี่ยนแปลง กรุณาตรวจ Quote ใหม่');
      }
      const expiry = await evaluateExpiryAdmission(client, {
        quest: { ...quest, progress_actual: fresh.progress },
        runnerConcurrency,
      });
      if (!expiry.eligible) throw new QuestshopError('QUEST_INSUFFICIENT_TIME', `เวลา Quest ${option.quest_name} ไม่เพียงพอ`);
    validated.push({ option, fresh, quest, price });
  }
  return validated;
}

async function createOrder(client, actorId, preflight, context, env) {
  const orderId = uuidv7();
  await client.query(`
      INSERT INTO orders(
        id, discord_user_id, account_id, account_username, account_avatar_url,
        trace_id, prelaunch
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [
      orderId, actorId, String(preflight.profile.id),
      preflight.profile.global_name ?? preflight.profile.username,
      avatarUrl(preflight.profile), context.traceId, env.PRELAUNCH,
  ]);
  try {
    await client.query(`
        INSERT INTO active_quest_accounts(account_id, order_id) VALUES ($1,$2)
    `, [String(preflight.profile.id), orderId]);
  } catch (error) {
    if (error.code === '23505') {
      throw new QuestshopError('ACCOUNT_ACTIVE_ORDER', 'บัญชี Quest นี้มีงานที่กำลังดำเนินการอยู่');
    }
    throw error;
  }
  return orderId;
}

async function storeOrderCredential(client, orderId, preflight, env, guildId) {
  const orderSecret = encryptSecret(preflight.token, env.DATA_ENCRYPTION_KEYS_JSON, `order:${orderId}:${guildId}`);
  await client.query(`
      INSERT INTO order_credentials(
        order_id, account_id, key_version, nonce, ciphertext, auth_tag
      ) VALUES ($1,$2,$3,$4,$5,$6)
  `, [
      orderId, String(preflight.profile.id), orderSecret.keyVersion,
      orderSecret.nonce, orderSecret.ciphertext, orderSecret.authTag,
  ]);
}

async function createOrderItems(client, orderId, session, validated) {
  const itemRows = [];
  for (let index = 0; index < validated.length; index += 1) {
      const { option, quest } = validated[index];
      const item = (await client.query(`
        INSERT INTO order_items(
          id, order_id, sequence_number, quest_id, quest_name, task_type,
          price_cents, price_rule_id, config_version, metadata_revision,
          engine_version, executor_version, contract_version,
          runner_state_schema_version, state, progress_actual, progress_bucket, deadline_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'SELECTED',$15,$16,$17)
        RETURNING *
      `, [
        uuidv7(), orderId, index + 1, option.quest_id, option.quest_name, option.task_type,
        option.price_cents, option.price_rule_id, session.config_version,
        quest.current_metadata_revision, ENGINE_VERSION, EXECUTOR_VERSION,
        QUEST_CONTRACT_VERSION, RUNNER_STATE_SCHEMA_VERSION,
        validated[index].fresh.progress,
        Math.floor(Math.min(99.999, validated[index].fresh.progress) / 25) * 25,
        option.deadline_at,
      ])).rows[0];
    itemRows.push(item);
  }
  return itemRows;
}

async function queueFirstOrderItem(client, itemRows, actorId, preflight, context) {
  const first = itemRows[0];
  const queued = (await client.query(`
      UPDATE order_items SET state = 'QUEUED', state_version = state_version + 1,
        updated_at = transaction_timestamp() WHERE id = $1 AND state = 'RESERVED' RETURNING *
  `, [first.id])).rows[0];
  await recordTransition(client, {
      aggregateType: 'ORDER_ITEM', aggregateId: first.id,
      fromState: 'RESERVED', toState: 'QUEUED', stateVersion: queued.state_version, context,
  });
  await client.query(`
      INSERT INTO runner_jobs(
        id, order_item_id, discord_user_id, account_id, state, deadline_at,
        engine_version, executor_version, contract_version,
        runner_state_schema_version, trace_id
      ) VALUES ($1,$2,$3,$4,'QUEUED',$5,$6,$7,$8,$9,$10)
  `, [
      uuidv7(), first.id, actorId, String(preflight.profile.id), first.deadline_at,
      ENGINE_VERSION, EXECUTOR_VERSION, QUEST_CONTRACT_VERSION,
      RUNNER_STATE_SCHEMA_VERSION, context.traceId,
  ]);
  await client.query(`
      INSERT INTO scheduler_users(discord_user_id) VALUES ($1)
      ON CONFLICT (discord_user_id) DO NOTHING
  `, [actorId]);
}

async function enqueueOrderHistory(client, itemRows, context) {
  for (let index = 0; index < itemRows.length; index += 1) {
      const item = itemRows[index];
      const notBefore = (await client.query(
        "SELECT clock_timestamp() + make_interval(secs => $1) AS value",
        [Math.floor(index / 5) * 10],
      )).rows[0].value;
    await enqueueProjection(client, {
        projectionType: 'QUEST_HISTORY', aggregateType: 'ORDER_ITEM', aggregateId: item.id,
        aggregateVersion: item.state_version + (index === 0 ? 1 : 0),
        surfaceKey: 'QUEST_HISTORY', notBefore, context,
    });
  }
}

async function finishCheckout(client, sessionId) {
  await client.query(`
      UPDATE interaction_sessions SET state = 'CONFIRMED', state_version = state_version + 1,
        updated_at = transaction_timestamp() WHERE id = $1
  `, [sessionId]);
  await client.query('DELETE FROM checkout_credentials WHERE session_id = $1', [sessionId]);
}

export async function confirmOrder({ sessionId, actorId, guildId, channelId = null,
  messageId = null, env, runnerConcurrency = env.RUNNER_CONCURRENCY }, context, options = {}) {
  const input = { sessionId, actorId, guildId, channelId, messageId };
  const preflight = await loadPreflight({ ...input, env }, options);
  const freshById = new Map(preflight.quests.map((quest) => [quest.id, quest]));
  return withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    const { session, selected } = await validateConfirmationSession(client, input, preflight);
    const validated = await validateSelectedOptions(client, selected, freshById, runnerConcurrency);
    const orderId = await createOrder(client, actorId, preflight, context, env);
    await storeOrderCredential(client, orderId, preflight, env, guildId);
    const itemRows = await createOrderItems(client, orderId, session, validated);
    await reserveOrderItemsInTransaction(client, {
      discordUserId: actorId,
      items: itemRows.map((item) => ({ itemId: item.id, amountCents: item.price_cents })),
    }, context);
    await queueFirstOrderItem(client, itemRows, actorId, preflight, context);
    await enqueueOrderHistory(client, itemRows, context);
    await finishCheckout(client, sessionId);
    return { orderId, items: itemRows, totalCents: sumCents(itemRows.map((item) => item.price_cents)) };
  });
}

export async function expireSessions(_input, _context, options = {}) {
  return withTransaction({ ...options, isolation: 'READ COMMITTED' }, async (client) => {
    const result = await client.query(`
      UPDATE interaction_sessions SET state = 'EXPIRED', state_version = state_version + 1,
        updated_at = clock_timestamp()
      WHERE state = 'ACTIVE' AND expires_at <= clock_timestamp() RETURNING id
    `);
    if (result.rows.length) {
      await client.query('DELETE FROM checkout_credentials WHERE session_id=ANY($1::uuid[])',
        [result.rows.map((row) => row.id)]);
    }
    await client.query(`
      DELETE FROM interaction_sessions
      WHERE state IN ('EXPIRED','CANCELLED','TERMINAL')
        AND updated_at < clock_timestamp() - interval '7 days'
    `);
    return result.rowCount;
  });
}
