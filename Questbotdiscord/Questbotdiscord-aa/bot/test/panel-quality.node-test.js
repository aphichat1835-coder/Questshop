import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = '12345678901234567';
process.env.DISCORD_GUILD_ID = '22345678901234567';
process.env.OWNER_ID = '32345678901234567';
process.env.DATABASE_PATH = `/tmp/questbot-panel-quality-${process.pid}.db`;
process.env.RUNNER_TOKEN_SECRET = 'panel-quality-test-secret-123456';

const panelCommand = await import('../src/commands/panel.js');
const { closeDatabase } = await import('../src/db.js');

test.after(() => closeDatabase());

test('panel exposes only the current run and stop actions', async () => {
  const replies = [];
  const interaction = {
    user: { id: 'test-owner' },
    replied: false,
    deferred: false,
    async reply(payload) {
      replies.push(payload);
      return payload;
    },
  };

  await panelCommand.sendPanel(interaction);
  const ids = replies[0].components.flatMap((row) => row.components.map((component) => component.data.custom_id));
  assert.deepEqual(ids, ['panel:run', 'panel:stop']);
});

test('legacy panel actions are rejected instead of dispatched', async () => {
  const replies = [];
  const interaction = {
    customId: 'panel:edit',
    replied: false,
    deferred: false,
    async reply(payload) {
      replies.push(payload);
      return payload;
    },
  };

  await panelCommand.handleButton(interaction);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /Panel รุ่นเก่า/);
});
