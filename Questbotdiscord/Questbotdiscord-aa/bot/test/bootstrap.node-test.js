import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBootstrapIncidentPayload,
  reportBootstrapIncident,
} from '../src/bootstrap-reporter.js';
import {
  installBootstrapProcessHandlers,
  reportWithinFatalBudget,
  resetBootstrapStateForTests,
  serializeBootstrapContext,
} from '../src/bootstrap.js';
import { INCIDENT } from '../src/incident-catalog.js';
import { createFakeDiscordWebhookUrl } from '../test-support/fake-webhook.js';

const WEBHOOK_URL = createFakeDiscordWebhookUrl('bootstrap');
const originalConsoleError = console.error;
console.error = () => {};

test.afterEach(() => resetBootstrapStateForTests());
test.after(() => { console.error = originalConsoleError; });

test('bootstrap context serialization handles circular values without default object strings', () => {
  const context = { component: 'bootstrap' };
  context.self = context;
  const serialized = serializeBootstrapContext(context);
  assert.equal(serialized, '{"component":"bootstrap","self":"[Circular]"}');
  assert.doesNotMatch(serialized, /\[object Object\]/);
});

test('bootstrap reporter sends without importing runtime config or database', async () => {
  let request;
  const result = await reportBootstrapIncident({
    code: INCIDENT.CLIENT_STARTUP_FAILED,
    error: new Error(
      `config import failed apiToken=must-not-leak secretKey=hidden databasePassword=hidden captchaToken=hidden ${WEBHOOK_URL}`,
    ),
    context: { stage: 'module-import', component: 'application', token: 'hidden' },
    env: { LOG_WEBHOOK_URL: WEBHOOK_URL },
    fetchFn: async (url, options) => {
      request = { url, options };
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(result.state, 'delivered');
  assert.equal(request.url, WEBHOOK_URL);
  const payload = JSON.parse(request.options.body);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.embeds[0].title, /บอทเริ่มระบบไม่สำเร็จ/);
  assert.match(JSON.stringify(payload), /module-import/);
  assert.doesNotMatch(
    JSON.stringify(payload),
    /must-not-leak|secretKey=hidden|databasePassword=hidden|captchaToken=hidden|webhook_token|"token"/,
  );
  assert.match(JSON.stringify(payload), /apiToken=\[REDACTED\]/);
});

test('bootstrap reporter fails closed when the webhook is missing or invalid', async () => {
  const missing = await reportBootstrapIncident({
    code: INCIDENT.CLIENT_STARTUP_FAILED,
    error: new Error('missing webhook'),
    env: {},
  });
  const invalid = await reportBootstrapIncident({
    code: INCIDENT.CLIENT_STARTUP_FAILED,
    error: new Error('invalid webhook'),
    env: { LOG_WEBHOOK_URL: 'https://example.com/hook' },
  });

  assert.equal(missing.state, 'logged_only');
  assert.equal(invalid.state, 'logged_only');
});

test('bootstrap payload enforces allowlisted context and Discord limits', () => {
  const payload = buildBootstrapIncidentPayload({
    code: INCIDENT.CLIENT_STARTUP_FAILED,
    error: new Error('M'.repeat(10_000)),
    context: {
      stage: 'module-import',
      component: 'application',
      arbitrary: 'must-not-survive',
    },
  });
  const embed = payload.embeds[0];
  const totalCharacters = [
    embed.title,
    embed.description,
    embed.footer.text,
    ...embed.fields.flatMap((field) => [field.name, field.value]),
  ].reduce((sum, value) => sum + value.length, 0);

  assert.doesNotMatch(JSON.stringify(payload), /must-not-survive/);
  assert.ok(embed.description.length <= 4096);
  assert.ok(embed.fields.every((field) => field.value.length <= 1024));
  assert.ok(totalCharacters <= 6000);
});

test('fatal reporting is bounded even when delivery never settles', async () => {
  const startedAt = Date.now();
  const result = await reportWithinFatalBudget(new Promise(() => {}), 10);
  assert.deepEqual(result, { state: 'budget_expired' });
  assert.ok(Date.now() - startedAt < 250);
});

test('bootstrap process handlers can be installed and removed without leaking listeners', () => {
  const beforeUnhandled = process.listenerCount('unhandledRejection');
  const beforeUncaught = process.listenerCount('uncaughtException');
  const cleanup = installBootstrapProcessHandlers({ exit: () => {} });
  assert.equal(process.listenerCount('unhandledRejection'), beforeUnhandled + 1);
  assert.equal(process.listenerCount('uncaughtException'), beforeUncaught + 1);
  cleanup();
  assert.equal(process.listenerCount('unhandledRejection'), beforeUnhandled);
  assert.equal(process.listenerCount('uncaughtException'), beforeUncaught);
});
