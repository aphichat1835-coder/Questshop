import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../src/db.js';

const EXPECTED_BUSY_TIMEOUT_MS = 5_000;

test('SQLite waits for bounded multi-process write contention instead of failing immediately', () => {
  assert.equal(db.pragma('busy_timeout', { simple: true }), EXPECTED_BUSY_TIMEOUT_MS);
});
