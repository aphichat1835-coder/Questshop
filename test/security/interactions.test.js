import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTestPool } from '../fixtures/postgres.js';
import { customId, parseCustomId } from '../../src/discord/components/custom-id.js';
import {
  bindSessionMessage,
  createAdminSession,
  loadAdminSession,
  terminateAdminSession,
} from '../../src/domain/admin/session-service.js';
import { createContext } from '../../src/shared/correlation.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

test('component custom IDs are versioned opaque and reject forged input', () => {
  const value = customId('quest_confirm');
  assert.ok(value.length <= 100);
  assert.equal(parseCustomId(value).route, 'quest_confirm');
  assert.equal(parseCustomId('qs:v2:quest_confirm:not-a-session'), null);
  assert.equal(parseCustomId('qs:v1:../../admin:00000000-0000-0000-0000-000000000000'), null);
});

test('Discord router delegates durable session state writes to domain services', async () => {
  const source = await readFile(new URL('../../src/discord/interactions/router.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /UPDATE\s+interaction_sessions/i);
  assert.doesNotMatch(source, /INSERT\s+INTO\s+(?:wallets|wallet_transactions|orders|order_items)/i);
  assert.match(source, /completeInteractionSession/);
  assert.match(source, /bindSessionMessage/);
});

test('server interaction session enforces actor guild channel operation and PostgreSQL expiry', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'ADMIN', actorId: 'actor-a', guildId: 'guild-a',
    idempotencyKey: 'session-security' });
  const session = await createAdminSession({ actorId: 'actor-a', guildId: 'guild-a',
    channelId: 'channel-a', messageId: 'message-a', operation: 'SECURITY_TEST',
    payload: { opaque: true }, configVersion: 1 }, context, { pool });
  assert.equal((await loadAdminSession({ sessionId: session.id, actorId: 'actor-a', guildId: 'guild-a',
    channelId: 'channel-a', messageId: 'message-a', operation: 'SECURITY_TEST' }, context, { pool })).id, session.id);
  await assert.rejects(() => loadAdminSession({ sessionId: session.id, actorId: 'actor-b',
    guildId: 'guild-a', channelId: 'channel-a', operation: 'SECURITY_TEST' }, context, { pool }),
  (error) => error.code === 'NOT_AUTHORIZED');
  await assert.rejects(() => loadAdminSession({ sessionId: session.id, actorId: 'actor-a',
    guildId: 'guild-a', channelId: 'channel-b', operation: 'SECURITY_TEST' }, context, { pool }),
  (error) => error.code === 'NOT_AUTHORIZED');
  await assert.rejects(() => loadAdminSession({ sessionId: session.id, actorId: 'actor-a',
    guildId: 'guild-a', channelId: 'channel-a', messageId: 'message-forged',
    operation: 'SECURITY_TEST' }, context, { pool }),
  (error) => error.code === 'NOT_AUTHORIZED');
  await pool.query("UPDATE interaction_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [session.id]);
  await assert.rejects(() => loadAdminSession({ sessionId: session.id, actorId: 'actor-a',
    guildId: 'guild-a', channelId: 'channel-a', operation: 'SECURITY_TEST' }, context, { pool }),
  (error) => error.code === 'SESSION_EXPIRED');
});

test('session message binding and terminal transition are domain-owned compare-and-swap operations', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const context = createContext({ actorType: 'CUSTOMER', actorId: 'actor-a', guildId: 'guild-a',
    idempotencyKey: 'session-cas' });
  const session = await createAdminSession({ actorId: 'actor-a', guildId: 'guild-a',
    channelId: 'channel-a', messageId: null, operation: 'SESSION_CAS', payload: {}, configVersion: 1 },
  context, { pool });
  const bound = await bindSessionMessage({ sessionId: session.id, actorId: 'actor-a', guildId: 'guild-a',
    messageId: 'reply-a', expectedVersion: session.state_version }, context, { pool });
  assert.equal(bound.message_id, 'reply-a');
  await assert.rejects(() => bindSessionMessage({ sessionId: session.id, actorId: 'actor-a', guildId: 'guild-a',
    messageId: 'reply-b', expectedVersion: session.state_version }, context, { pool }),
  (error) => error.code === 'STALE_SESSION');
  const terminal = await terminateAdminSession({ sessionId: session.id, actorId: 'actor-a', guildId: 'guild-a',
    expectedVersion: bound.state_version }, context, { pool });
  assert.equal(terminal.state, 'TERMINAL');
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM state_transitions
    WHERE aggregate_type='INTERACTION_SESSION' AND aggregate_id=$1 AND to_state='TERMINAL'`, [session.id])).rows[0].count), 1);
  await assert.rejects(() => terminateAdminSession({ sessionId: session.id, actorId: 'actor-a', guildId: 'guild-a',
    expectedVersion: terminal.state_version }, context, { pool }), (error) => error.code === 'STALE_SESSION');
});
