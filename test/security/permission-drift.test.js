import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { checkPermissionDrift, repairPermissionDrift } from '../../src/discord/permissions/drift.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

function permissions(value) {
  return { has: () => value };
}

function channel({ exposed = false, inheritedRole = false }) {
  return {
    permissionsFor: (principal) => permissions(principal.id === 'everyone' ? exposed
      : inheritedRole ? principal.id === 'unexpected-role' || principal.id === 'bot' : true),
    permissionOverwrites: { cache: new Map(exposed ? [[
      'unexpected-role', { id: 'unexpected-role', allow: { has: (flag) => flag === PermissionFlagsBits.ViewChannel } },
    ]] : []) },
  };
}

test('permission drift isolates only a private surface that can leak', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,expected_permissions,state)
    VALUES ('LOG_PAYMENTS','guild','private-channel','private-message',$1,'ACTIVE'),
      ('QUEST_AUTO','guild','public-channel','public-message',$2,'ACTIVE')`,
  [{ private: true }, { private: false }]);
  const guild = {
    roles: { everyone: { id: 'everyone' }, cache: new Map([
      ['everyone', { id: 'everyone' }], ['unexpected-role', { id: 'unexpected-role' }],
    ]) },
    members: { fetchMe: async () => ({ id: 'bot', roles: { cache: new Map() } }) },
    channels: { fetch: async (id) => channel({ exposed: false, inheritedRole: id === 'private-channel' }) },
  };
  const client = { guilds: { fetch: async () => guild } };
  const result = await checkPermissionDrift({ client, pool, env: {
    DISCORD_GUILD_ID: 'guild', OWNER_ID: 'owner',
  } });
  assert.equal(result.find((item) => item.surface === 'LOG_PAYMENTS').drifted, true);
  assert.equal(result.find((item) => item.surface === 'QUEST_AUTO').drifted, false);
  const states = (await pool.query('SELECT surface_key,state FROM surfaces ORDER BY surface_key')).rows;
  assert.deepEqual(states, [
    { surface_key: 'LOG_PAYMENTS', state: 'DRIFTED' },
    { surface_key: 'QUEST_AUTO', state: 'ACTIVE' },
  ]);
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM incidents
    WHERE incident_code='PERMISSION_DRIFT' AND scope='LOG_PAYMENTS' AND state='OPEN'`)).rows[0].count), 1);
});

test('Owner repair denies an inherited unexpected role then revalidates the one affected surface', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,expected_permissions,state)
    VALUES ('LOG_SYSTEM','guild','repair-channel','repair-message',$1,'DRIFTED')`, [{ private: true }]);
  const denied = new Set();
  const repairChannel = {
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: (principal) => permissions(principal.id === 'bot'
      || (principal.id === 'unexpected-role' && !denied.has(principal.id))),
    permissionOverwrites: {
      cache: new Map(),
      edit: async (id) => { denied.add(id); },
    },
  };
  const guild = {
    roles: { everyone: { id: 'everyone' }, cache: new Map([
      ['everyone', { id: 'everyone' }], ['unexpected-role', { id: 'unexpected-role' }],
    ]) },
    members: { fetchMe: async () => ({ id: 'bot', roles: { cache: new Map() } }) },
    channels: { fetch: async () => repairChannel },
  };
  const client = { guilds: { fetch: async () => guild } };
  const env = { DISCORD_GUILD_ID: 'guild', OWNER_ID: 'owner' };
  const context = createContext({ actorType: 'OWNER', actorId: 'owner', guildId: 'guild',
    idempotencyKey: 'permission-repair' });
  const repaired = await repairPermissionDrift({ client, pool, env, surfaceKey: 'LOG_SYSTEM',
    adminRoleId: null, reason: 'remove inherited role access' }, context);
  assert.equal(repaired.drifted, false);
  assert.ok(denied.has('unexpected-role'));
  assert.equal((await pool.query("SELECT state FROM surfaces WHERE surface_key='LOG_SYSTEM'"))
    .rows[0].state, 'ACTIVE');
  assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM admin_audit_logs
    WHERE action='PERMISSION_REPAIR' AND target_id='LOG_SYSTEM'`)).rows[0].count), 1);
});
