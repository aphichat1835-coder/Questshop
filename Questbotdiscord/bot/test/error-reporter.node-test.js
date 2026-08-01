import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeDiscordWebhookUrl } from '../test-support/fake-webhook.js';

const WEBHOOK_URL = createFakeDiscordWebhookUrl('reporter');
const CRITICAL_EMBED_COLOR = Number.parseInt('ED4245', 16);
const RECOVERY_EMBED_COLOR = Number.parseInt('57F287', 16);
process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = '12345678901234567';
process.env.DISCORD_GUILD_ID = '22345678901234567';
process.env.OWNER_ID = '32345678901234567';
process.env.RUNNER_TOKEN_SECRET = 'test-runner-token-secret-32-characters';
process.env.LOG_WEBHOOK_URL = WEBHOOK_URL;
process.env.ALLOW_TEST_WEBHOOK = 'true';

const { INCIDENT } = await import('../src/incident-catalog.js');
const {
  buildIncidentWebhookPayload,
  getIncidentReporterStatus,
  isEmergencyIncident,
  redactSensitive,
  reportCriticalError,
  reportIncident,
  reportRecovery,
  resetIncidentReporterStateForTests,
} = await import('../src/error-reporter.js');

const originalConsoleError = console.error;
const originalFetch = globalThis.fetch;
console.error = () => {};

function contextFromPayload(payload) {
  const field = payload.embeds[0].fields.find((item) => item.name === 'Context');
  assert.ok(field, 'expected a Context field');
  return JSON.parse(field.value.replace(/^```\n/, '').replace(/\n```$/, ''));
}

function deferred() {
  let resolve;
  const promise = new Promise((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetIncidentReporterStateForTests();
});

test.after(() => {
  console.error = originalConsoleError;
  delete process.env.ALLOW_TEST_WEBHOOK;
});

test('ordinary operational errors stay in Render logs and do not call the webhook', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(null, { status: 204 });
  };

  const result = await reportCriticalError(
    'Runner authentication',
    new Error('one account token expired'),
  );

  assert.equal(attempts, 0);
  assert.deepEqual(result, { state: 'logged' });
  assert.equal(isEmergencyIncident('Runner authentication', new Error('expired')), false);
});

test('structured incidents send an allowlisted, mention-safe backend embed', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(null, { status: 204 });
  };

  const result = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error(`backup failed near ${WEBHOOK_URL}`),
    context: {
      consecutiveFailures: 3,
      backupAgeHours: 27,
      storageMode: 'persistent-candidate',
      token: 'must-not-leak',
      arbitraryInternalObject: { password: 'hidden' },
    },
  });

  assert.equal(result.state, 'delivered');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, WEBHOOK_URL);
  const payload = JSON.parse(requests[0].options.body);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.embeds[0].title, /การป้องกันฐานข้อมูล/);
  assert.equal(payload.embeds[0].color, CRITICAL_EMBED_COLOR);
  assert.match(payload.embeds[0].description, /REDACTED_WEBHOOK/);
  assert.equal(contextFromPayload(payload).consecutiveFailures, 3);
  assert.doesNotMatch(JSON.stringify(payload), /must-not-leak|arbitraryInternalObject|webhook_token/);
});

test('concurrent incidents reserve one delivery slot before awaiting the webhook', async () => {
  const response = deferred();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return response.promise;
  };

  const firstPromise = reportIncident({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('EADDRINUSE'),
    scope: 'health:10000',
    now: 1_000,
  });
  await Promise.resolve();
  const duplicate = await reportIncident({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('same invariant while first request is pending'),
    scope: 'health:10000',
    now: 1_001,
  });

  assert.equal(duplicate.state, 'suppressed');
  assert.equal(attempts, 1);
  response.resolve(new Response(null, { status: 204 }));
  const first = await firstPromise;
  assert.equal(first.state, 'delivered');
  assert.equal(first.incidentId, duplicate.incidentId);
});

test('delivered incidents stay open and suppress repeats until recovery', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(null, { status: 204 });
  };

  const first = await reportIncident({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('EADDRINUSE'),
    scope: 'health:10000',
    now: 0,
  });
  const duplicate = await reportIncident({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('same incident much later'),
    scope: 'health:10000',
    now: 24 * 60 * 60_000,
  });
  const distinctScope = await reportIncident({
    code: INCIDENT.HEALTH_SERVER_BIND_FAILED,
    error: new Error('EADDRINUSE'),
    scope: 'health:10001',
    now: 24 * 60 * 60_000,
  });

  assert.equal(first.state, 'delivered');
  assert.equal(duplicate.state, 'suppressed');
  assert.equal(distinctScope.state, 'delivered');
  assert.equal(attempts, 2);
  assert.equal(getIncidentReporterStatus().suppressedIncidents, 1);
});

test('failed delivery has a short retry guard and can deliver on a later occurrence', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts <= 2) return new Response(null, { status: 503 });
    return new Response(null, { status: 204 });
  };

  const failed = await reportIncident({
    code: INCIDENT.DISCORD_LOGIN_FAILED,
    error: new Error('login failed'),
    scope: 'runtime',
    now: 1_000,
  });
  const deferredRetry = await reportIncident({
    code: INCIDENT.DISCORD_LOGIN_FAILED,
    error: new Error('login still failed'),
    scope: 'runtime',
    now: 30_000,
  });
  const retried = await reportIncident({
    code: INCIDENT.DISCORD_LOGIN_FAILED,
    error: new Error('login still failed'),
    scope: 'runtime',
    now: 61_001,
  });

  assert.equal(failed.state, 'delivery_unknown');
  assert.equal(deferredRetry.state, 'retry_deferred');
  assert.equal(retried.state, 'delivered');
  assert.equal(retried.incidentId, failed.incidentId);
  assert.equal(attempts, 3);
});

test('an open incident sends one recovery using the same incident id', async () => {
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  };

  const opened = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error('three backup failures'),
    scope: 'database-backup',
    context: { consecutiveFailures: 3, backupAgeHours: 27 },
  });
  const recovered = await reportRecovery({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    scope: 'database-backup',
    context: { consecutiveFailures: 0, backupAgeHours: 0 },
  });
  const duplicateRecovery = await reportRecovery({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    scope: 'database-backup',
  });

  assert.equal(recovered.state, 'delivered');
  assert.equal(duplicateRecovery.state, 'not_open');
  assert.equal(payloads.length, 2);
  assert.match(payloads[1].embeds[0].title, /^✅/);
  assert.equal(payloads[1].embeds[0].color, RECOVERY_EMBED_COLOR);
  assert.ok(JSON.stringify(payloads[1]).includes(opened.incidentId));
});

test('failed recovery can be retried using the same incident id', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) return new Response(null, { status: 204 });
    if (attempts <= 3) return new Response(null, { status: 503 });
    return new Response(null, { status: 204 });
  };

  const opened = await reportIncident({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    error: new Error('backup unavailable'),
    scope: 'database-backup',
    now: 1_000,
  });
  const failedRecovery = await reportRecovery({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    scope: 'database-backup',
    now: 2_000,
  });
  const deferredRetry = await reportRecovery({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    scope: 'database-backup',
    now: 30_000,
  });
  const recovered = await reportRecovery({
    code: INCIDENT.BACKUP_PROTECTION_LOST,
    scope: 'database-backup',
    now: 62_001,
  });

  assert.equal(failedRecovery.state, 'delivery_unknown');
  assert.equal(deferredRetry.state, 'retry_deferred');
  assert.equal(recovered.state, 'delivered');
  assert.equal(recovered.incidentId, opened.incidentId);
  assert.equal(attempts, 4);
});

test('Quest transport failures require three observations before one alert', async () => {
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  };
  const error = new Error('Quest API endpoints unavailable: upstream timeout');

  const first = await reportCriticalError('Quest API compatibility', error);
  const second = await reportCriticalError('Quest API compatibility', error);
  const third = await reportCriticalError('Quest API compatibility', error);

  assert.equal(first.state, 'logged_threshold');
  assert.equal(first.count, 1);
  assert.equal(second.state, 'logged_threshold');
  assert.equal(second.count, 2);
  assert.equal(third.state, 'delivered');
  assert.equal(payloads.length, 1);
  assert.match(JSON.stringify(payloads[0]), /QUEST_API_TRANSPORT_OUTAGE/);
  assert.equal(contextFromPayload(payloads[0]).consecutiveFailures, 3);
});

test('scheduled restore failures aggregate before sending one backend incident', async () => {
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  };

  for (let row = 1; row <= 3; row++) {
    await reportCriticalError(
      `Restore Scheduled Runner #${row}`,
      new Error('Unsupported state or unable to authenticate data'),
    );
  }

  assert.equal(payloads.length, 1);
  assert.match(JSON.stringify(payloads[0]), /RUNNER_RESTORE_SYSTEM_FAILED/);
  const context = contextFromPayload(payloads[0]);
  assert.equal(context.decryptFailures, 3);
  assert.equal(context.failed, 3);
  assert.doesNotMatch(JSON.stringify(payloads[0]), /Runner #1|Runner #2/);
});

test('legacy threshold evidence expires instead of accumulating forever', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(null, { status: 204 });
  };
  const error = new Error('Quest API endpoints unavailable: temporary outage');

  const first = await reportCriticalError('Quest API compatibility', error, { now: 0 });
  const expired = await reportCriticalError('Quest API compatibility', error, { now: 10 * 60_000 + 1 });

  assert.equal(first.count, 1);
  assert.equal(expired.count, 1);
  assert.equal(attempts, 0);
});

test('legacy compatibility only escalates supported system sources', () => {
  assert.equal(
    isEmergencyIncident(
      'Quest API compatibility',
      Object.assign(new Error('Quest API schema changed'), { name: 'QuestCompatibilityError' }),
    ),
    true,
  );
  assert.equal(
    isEmergencyIncident(
      'Quest API compatibility',
      new Error('unknown events: WATCH_NEW_PROMO'),
    ),
    false,
  );
  assert.equal(isEmergencyIncident('Uncaught exception', new Error('boom')), true);
  assert.equal(isEmergencyIncident('Discord shard 0', new Error('temporary')), false);
});

test('incident payload remains within Discord embed limits', () => {
  const payload = buildIncidentWebhookPayload({
    code: INCIDENT.SYSTEM_FAILURE,
    error: new Error('M'.repeat(10_000)),
    context: { component: 'C'.repeat(5000) },
  });
  const embed = payload.embeds[0];
  const totalCharacters = [
    embed.title,
    embed.description,
    embed.footer.text,
    ...embed.fields.flatMap((field) => [field.name, field.value]),
  ].reduce((sum, value) => sum + value.length, 0);

  assert.ok(embed.description.length <= 4096);
  assert.ok(embed.fields.length <= 25);
  assert.ok(embed.fields.every((field) => field.value.length <= 1024));
  assert.ok(totalCharacters <= 6000);
});

test('redaction removes webhook URLs and compound secret assignments', () => {
  const redacted = redactSensitive(
    `url=${WEBHOOK_URL} apiToken=hidden secretKey=hidden databasePassword=hidden captchaToken=hidden`,
  );
  assert.equal(
    redacted,
    'url=[REDACTED_WEBHOOK] apiToken=[REDACTED] secretKey=[REDACTED] databasePassword=[REDACTED] captchaToken=[REDACTED]',
  );
});
