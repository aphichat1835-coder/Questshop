import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowlistedIncidentContext,
  getIncidentDefinition,
  INCIDENT,
  listIncidentCodes,
} from '../src/incident-catalog.js';

test('every public incident code has an immutable operational contract', () => {
  const codes = listIncidentCodes();
  assert.deepEqual(new Set(codes), new Set(Object.values(INCIDENT)));
  for (const code of codes) {
    const definition = getIncidentDefinition(code);
    assert.ok(definition.title.length >= 5);
    assert.ok(definition.impact.length >= 10);
    assert.ok(definition.action.length >= 10);
    assert.ok(Array.isArray(definition.context));
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(definition.context), true);
  }
});

test('incident context only keeps explicitly allowed values', () => {
  const context = allowlistedIncidentContext(INCIDENT.BACKUP_PROTECTION_LOST, {
    consecutiveFailures: 3,
    lastSuccessAt: '2026-07-25T00:00:00.000Z',
    backupAgeHours: 27,
    storageMode: 'persistent-candidate',
    unapprovedField: 'must-not-survive',
    nested: { internalValue: 'must-not-survive' },
  });

  assert.deepEqual(context, {
    consecutiveFailures: 3,
    lastSuccessAt: '2026-07-25T00:00:00.000Z',
    backupAgeHours: 27,
    storageMode: 'persistent-candidate',
  });
  assert.doesNotMatch(JSON.stringify(context), /must-not-survive/);
});

test('incident allowlists cannot be expanded at runtime', () => {
  const definition = getIncidentDefinition(INCIDENT.BACKUP_PROTECTION_LOST);
  assert.throws(() => definition.context.push('token'), TypeError);
  const context = allowlistedIncidentContext(INCIDENT.BACKUP_PROTECTION_LOST, {
    consecutiveFailures: 3,
    token: 'must-not-survive',
  });
  assert.deepEqual(context, { consecutiveFailures: 3 });
});

test('unknown and inherited incident keys fail closed', () => {
  for (const code of ['UNKNOWN_CODE', 'constructor', 'toString', '__proto__']) {
    assert.throws(() => getIncidentDefinition(code), /Unknown incident code/);
    assert.throws(() => allowlistedIncidentContext(code, {}), /Unknown incident code/);
  }
});
