import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags } from 'discord.js';
import {
  ACKNOWLEDGEMENT, acknowledgementOf, installResponseController,
} from '../../src/discord/interactions/response-controller.js';

test('response controller converts deprecated ephemeral options and owns one acknowledgement', async () => {
  const calls = [];
  const interaction = {
    deferReply: async (options) => { calls.push(['deferReply', options]); },
    reply: async (options) => { calls.push(['reply', options]); },
  };
  installResponseController(interaction);
  await interaction.deferReply({ ephemeral: true });
  assert.deepEqual(calls, [['deferReply', { flags: MessageFlags.Ephemeral }]]);
  assert.equal(acknowledgementOf(interaction), ACKNOWLEDGEMENT.DEFER_REPLY);
  assert.equal(await interaction.deferReply({ ephemeral: true }), null);
  await assert.rejects(() => interaction.reply({ content: 'late' }),
    (error) => error.code === 'INTERACTION_ALREADY_ACKNOWLEDGED');
});

test('response controller preserves a modal as a terminal acknowledgement', async () => {
  const interaction = { showModal: async () => {} };
  installResponseController(interaction);
  await interaction.showModal({ customId: 'qs:v1:test:00000000-0000-0000-0000-000000000000' });
  assert.equal(acknowledgementOf(interaction), ACKNOWLEDGEMENT.MODAL);
});

test('response controller normalizes rendered replies and reports the actual message once', async () => {
  const messages = [];
  const interaction = {
    deferReply: async () => {},
    editReply: async (payload) => ({ id: 'ephemeral-reply', payload }),
  };
  installResponseController(interaction, { onMessage: async (event) => messages.push(event) });
  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply({ content: '@everyone '.repeat(500), allowedMentions: { parse: ['everyone'] } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].result.id, 'ephemeral-reply');
  assert.ok(messages[0].payload.content.length <= 2_000);
  assert.deepEqual(messages[0].payload.allowedMentions.parse, []);
  assert.match(messages[0].payload.content, /@\u200beveryone/);
});
