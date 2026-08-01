import './setup-env.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

test('commands and lifecycle route runner operations through runner-service', async () => {
  const [app, run, panel, control] = await Promise.all([
    source('../src/app.js'),
    source('../src/commands/run.js'),
    source('../src/commands/panel.js'),
    source('../src/runner-control.js'),
  ]);

  for (const content of [app, run, panel, control]) {
    assert.match(content, /quest\/runner-service\.js/);
    assert.doesNotMatch(content, /from ['"]\.\.?(?:\/src)?\/discord-runner\.js['"]/);
  }
});

test('application startup installs Discord API v10 runtime before login', async () => {
  const app = await source('../src/app.js');
  const installAt = app.indexOf('installDiscordApiRuntime()');
  const loginAt = app.indexOf('client.login(config.token)');
  assert.ok(installAt >= 0);
  assert.ok(loginAt >= 0);
  assert.ok(installAt < loginAt);
});

test('v10 runtime is fixed to the latest available API version', async () => {
  const runtime = await source('../src/quest/discord-api-runtime.js');
  assert.match(runtime, /DISCORD_API_VERSION = 10/);
  assert.doesNotMatch(runtime, /DISCORD_API_VERSION = 9/);
});
