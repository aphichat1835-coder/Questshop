import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { createTestPool } from '../fixtures/postgres.js';
import { createContext } from '../../src/shared/correlation.js';
import { reconcileSurfaceAnchors } from '../../src/discord/surfaces/setup.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool?.end(); });

function permissions(...allowed) { return { has: (flag) => allowed.includes(flag) }; }

test('payment-log permission drift quarantines the durable surface before more outbox delivery', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  await pool.query(`INSERT INTO surfaces(surface_key,guild_id,channel_id,message_id,state,last_validated_at)
    VALUES('LOG_PAYMENTS','guild','payments','message','ACTIVE',clock_timestamp())`);
  const everyone = { id: 'guild', name: '@everyone', permissions: permissions() };
  const roles = new Map([[everyone.id, everyone]]);
  const channel = {
    id: 'payments', guild: { roles: { everyone, cache: roles } },
    client: { user: { id: 'bot' }, questshop: { env: { OWNER_ID: 'owner' } } },
    permissionOverwrites: { cache: new Map() },
    permissionsFor: () => permissions(PermissionFlagsBits.ViewChannel),
    isTextBased: () => true, isDMBased: () => false,
  };
  const guild = { channels: { fetch: async () => channel } };
  const client = { guilds: { fetch: async () => guild } };
  const context = createContext({ actorType: 'SYSTEM', actorId: 'maintenance', guildId: 'guild',
    idempotencyKey: 'payment-surface-quarantine' });

  const results = await reconcileSurfaceAnchors({ client, pool, env: { DISCORD_GUILD_ID: 'guild' },
    config: { version: 1, values: {} } }, context);
  assert.equal(results[0].reason, 'SURFACE_CHANNEL_INVALID');
  assert.equal((await pool.query("SELECT state FROM surfaces WHERE surface_key='LOG_PAYMENTS'")).rows[0].state, 'DISABLED');
  const incident = (await pool.query(`SELECT state FROM incidents WHERE incident_code='DISCORD_SURFACE_RECONCILE_FAILED'
    AND scope='LOG_PAYMENTS' ORDER BY opened_at DESC LIMIT 1`)).rows[0];
  assert.equal(incident.state, 'OPEN');
});
