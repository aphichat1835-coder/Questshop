import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('runtime has no Permission Drift detector or repair route', async () => {
  const sources = [
    await readFile(new URL('../../src/bootstrap/startup.js', import.meta.url), 'utf8'),
    await readFile(new URL('../../src/workers/maintenance-worker.js', import.meta.url), 'utf8'),
    await readFile(new URL('../../src/workers/outbox-worker.js', import.meta.url), 'utf8'),
    await readFile(new URL('../../src/discord/interactions/router.js', import.meta.url), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(sources, /checkPermissionDrift|repairPermissionDrift|PERMISSION_DRIFT/);
  assert.doesNotMatch(sources, /perm_repair/);
});

test('surface installation retains only the one-time minimum permission precondition', async () => {
  const source = await readFile(new URL('../../src/discord/surfaces/setup.js', import.meta.url), 'utf8');
  assert.match(source, /SURFACE_PERMISSION_MISSING/);
  assert.match(source, /PRIVATE_SURFACE_EXPOSED/);
  assert.doesNotMatch(source, /checkPermissionDrift|repairPermissionDrift/);
});
