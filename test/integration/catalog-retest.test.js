import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('catalog retests are event-driven and maintenance does not force a 24-hour retest', async () => {
  const maintenance = await readFile(new URL('../../src/workers/maintenance-worker.js', import.meta.url), 'utf8');
  const catalog = await readFile(new URL('../../src/domain/catalog/service.js', import.meta.url), 'utf8');
  assert.doesNotMatch(maintenance, /maintainQuestRetests/);
  assert.doesNotMatch(maintenance, /quest_test_runs[\s\S]{0,400}24 hours/);
  assert.match(catalog, /requiresRetest/);
  assert.match(catalog, /createMonitorTestBatch\(client, \{ quest, context, force: needsRetest \}/);
});
