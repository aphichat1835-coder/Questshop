import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('runtime has no generic Permission Drift detector or repair route', async () => {
  const sources = [
    await readFile(new URL('../../src/bootstrap/startup.js', import.meta.url), 'utf8'),
    await readFile(new URL('../../src/workers/maintenance-worker.js', import.meta.url), 'utf8'),
    await readFile(new URL('../../src/workers/outbox-worker.js', import.meta.url), 'utf8'),
    await readFile(new URL('../../src/discord/interactions/router.js', import.meta.url), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(sources, /checkPermissionDrift|repairPermissionDrift|PERMISSION_DRIFT/);
  assert.doesNotMatch(sources, /perm_repair/);
});

test('startup requires Administrator and LOG_PAYMENTS has a narrow privacy guard without generic repair', async () => {
  const startup = await readFile(new URL('../../src/bootstrap/startup.js', import.meta.url), 'utf8');
  const setup = await readFile(new URL('../../src/discord/surfaces/setup.js', import.meta.url), 'utf8');
  const outbox = await readFile(new URL('../../src/workers/outbox-worker.js', import.meta.url), 'utf8');
  assert.match(startup, /Administrator/);
  assert.match(setup, /assertSensitiveSurfacePrivacy/);
  assert.match(setup, /LOG_PAYMENTS/);
  assert.doesNotMatch(outbox, /checkPermissionDrift|repairPermissionDrift|PERMISSION_DRIFT/);
  assert.doesNotMatch(setup, /SURFACE_PERMISSION_MISSING|checkPermissionDrift|repairPermissionDrift/);
});
