import { createFakeDiscordWebhookUrl } from './support/fake-webhook.mjs';

process.env.DISCORD_BOT_TOKEN ??= 'smoke-bot-token';
process.env.DISCORD_CLIENT_ID ??= '12345678901234567';
process.env.DISCORD_GUILD_ID ??= '22345678901234567';
process.env.OWNER_ID ??= '32345678901234567';
process.env.RUNNER_TOKEN_SECRET ??= 'smoke-secret-at-least-16-chars';
process.env.LOG_WEBHOOK_URL ??= createFakeDiscordWebhookUrl('smoke');
process.env.DATABASE_PATH ??= ':memory:';
process.env.QUESTBOT_TEST_MODE = 'true';

const token = process.env.DISCORD_USER_TOKEN?.trim();
if (!token) {
  console.error('DISCORD_USER_TOKEN is required. The smoke test is read-only and never prints the token.');
  process.exit(2);
}

const {
  fetchMe,
  fetchQuests,
  getQuestEngineStatus,
} = await import('../src/discord-runner.js');

try {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  timeout.unref?.();

  const me = await fetchMe(token, controller.signal);
  const expectedAccountId = process.env.EXPECTED_DISCORD_ACCOUNT_ID?.trim();
  if (expectedAccountId && me.id !== expectedAccountId) {
    throw new Error('Smoke token belongs to a different account than EXPECTED_DISCORD_ACCOUNT_ID');
  }

  const quests = await fetchQuests(token, controller.signal, {
    key: `smoke:${me.id}`,
    ownerId: 'smoke',
    accountId: me.id,
    username: me.username,
    jobKey: 'manual-smoke',
    mode: 'smoke',
  });
  clearTimeout(timeout);

  const status = getQuestEngineStatus(`smoke:${me.id}`);
  if (['error', 'incompatible'].includes(status.state)) {
    throw new Error(status.lastError ?? `Quest API status is ${status.state}`);
  }

  const summary = {
    accountVerified: expectedAccountId ? true : 'not-configured',
    questCount: quests.length,
    supportedCount: status.supportedCount,
    state: status.state,
    endpoint: status.questListPath,
    unknownEvents: status.unknownEvents,
    schemaIssues: status.schemaIssues,
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(`Quest API smoke test failed: ${error.message}`);
  process.exit(1);
}
