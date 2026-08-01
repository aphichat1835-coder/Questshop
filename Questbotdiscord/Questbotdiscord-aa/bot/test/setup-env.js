import { createFakeDiscordWebhookUrl } from '../test-support/fake-webhook.js';

process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = '12345678901234567';
process.env.DISCORD_GUILD_ID = '22345678901234567';
process.env.OWNER_ID = '32345678901234567';
process.env.RUNNER_TOKEN_SECRET = 'test-runner-token-secret-32-characters';
process.env.LOG_WEBHOOK_URL = createFakeDiscordWebhookUrl('shared');
