import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApiStatusEmbed } from '../src/commands/api-status.js';

function statusSnapshot(lastError) {
  return {
    dbOk: true,
    dbError: null,
    latency: 1,
    ping: 2,
    memory: { rss: 1, heapUsed: 1, heapTotal: 1 },
    aggregate: {
      state: 'error',
      accountCount: 1,
      lastCheckAt: null,
      lastSuccessfulCheckAt: null,
      questCount: 0,
      supportedCount: 0,
      excludedCount: 0,
      questListPath: '/quests/@me',
      enrollmentBlockedUntil: null,
      unknownEvents: [],
      schemaIssues: [],
      lastVerifiedProgressAt: null,
      lastVerifiedCompletionAt: null,
      lastVerifiedClaimAt: null,
      lastError,
    },
    accountStatuses: [],
    jobs: [],
    persisted: [],
    activeDurable: [],
    activeRoles: [],
    workerHolders: new Set(),
    activeClaims: [],
    transport: {
      apiVersion: 10,
      installed: true,
      rateLimit: {
        queued: 0,
        active: 0,
        rateLimited: 0,
        globalRateLimits: 0,
        knownRoutes: 0,
        knownScopes: 0,
        blockedBuckets: 0,
        openCircuits: 0,
        halfOpenCircuits: 0,
        checkpointErrors: 0,
        scheduleHintErrors: 0,
      },
    },
  };
}

test('api-status never exposes secret-shaped text from aggregate Quest errors', () => {
  const embed = buildApiStatusEmbed(statusSnapshot('apiToken=hidden-value')).toJSON();
  const errorField = embed.fields.find((field) => field.name === '❌ Quest API Error ล่าสุด');

  assert.ok(errorField);
  assert.match(errorField.value, /apiToken=\[REDACTED\]/);
  assert.doesNotMatch(errorField.value, /hidden-value/);
});
