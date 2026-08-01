import assert from 'node:assert/strict';
import { createFakeDiscordWebhookUrl } from './support/fake-webhook.mjs';

process.env.DISCORD_BOT_TOKEN ??= 'fixture-bot-token';
process.env.DISCORD_CLIENT_ID ??= '12345678901234567';
process.env.DISCORD_GUILD_ID ??= '22345678901234567';
process.env.OWNER_ID ??= '32345678901234567';
process.env.RUNNER_TOKEN_SECRET ??= 'fixture-secret-at-least-16-chars';
process.env.LOG_WEBHOOK_URL = createFakeDiscordWebhookUrl('fixture');
process.env.DATABASE_PATH ??= ':memory:';
process.env.QUESTBOT_TEST_MODE = 'true';

const { default: raw } = await import(
  '../fixtures/quest-api.sample.json',
  { with: { type: 'json' } },
);
assert.equal(raw.fixture_version, 1, 'Unsupported fixture_version');
assert.ok(raw.response && Array.isArray(raw.response.quests), 'Fixture must contain response.quests[]');
assert.ok(raw.response.quests.length >= 3, 'Fixture must cover video, game and completed Quest shapes');

const { normalizeQuest } = await import('../src/discord-runner.js');
const normalized = raw.response.quests.map(normalizeQuest);
const byId = new Map(normalized.map((quest) => [quest.id, quest]));

const video = byId.get('fixture-video-quest');
assert.ok(video, 'Missing video fixture');
assert.equal(video.eventName, 'WATCH_VIDEO');
assert.equal(video.secondsNeeded, 60);
assert.equal(video.progressSecs, 15);
assert.equal(video.progress, 25);
assert.deepEqual(video.rewardPlatforms, [0, 4]);
assert.deepEqual(video.schemaIssues, []);

const game = byId.get('fixture-game-quest');
assert.ok(game, 'Missing game fixture');
assert.equal(game.eventName, 'PLAY_ON_DESKTOP');
assert.equal(game.progressKey, 'desktop_task');
assert.equal(game.applicationId, 'fixture-game-app');
assert.equal(Math.floor(game.progress), 33);
assert.deepEqual(game.schemaIssues, []);

const completed = byId.get('fixture-completed-quest');
assert.ok(completed, 'Missing completed fixture');
assert.equal(completed.completed, true);
assert.equal(completed.claimed, true);
assert.equal(completed.progress, 100);

const serialized = JSON.stringify(raw);
for (const forbidden of ['Authorization', 'token_ciphertext', 'token_salt', 'email', 'cookie']) {
  assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, `Fixture contains forbidden field: ${forbidden}`);
}

console.log(`Quest schema fixture valid: ${normalized.length} Quest shapes`);
