import './setup-env.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildApiStatusEmbed } from '../src/commands/api-status.js';

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

test('api-status exposes rate-limit hardening and worker ownership counts', async () => {
  const status = await source('../src/commands/api-status.js');
  assert.match(status, /listActiveWorkerHolders/);
  assert.match(status, /listScheduledRunnerClaims/);
  assert.match(status, /knownScopes/);
  assert.match(status, /openCircuits/);
  assert.match(status, /halfOpenCircuits/);
  assert.match(status, /checkpointErrors/);
  assert.match(status, /VERIFYING_ENROLLMENT/);
  assert.match(status, /Scheduled claims/);
});

test('api-status reports distinct worker and claim totals without rendering holder identifiers', async () => {
  const status = await source('../src/commands/api-status.js');
  assert.match(status, /new Set\(listActiveWorkerHolders\(\)\)/);
  assert.match(status, /workerHolders\.size/);
  assert.match(status, /activeClaims\.length/);
  assert.doesNotMatch(status, /workerHolders\.length/);
  assert.doesNotMatch(status, /workerHolders\.join/);
  assert.doesNotMatch(status, /activeClaims\.map/);
});

test('api-status embed preserves topology, transport and durable runner counts', () => {
  const embed = buildApiStatusEmbed({
    dbOk: true,
    dbError: null,
    latency: 7,
    ping: 12,
    memory: { rss: 10 * 1024 * 1024, heapUsed: 4 * 1024 * 1024, heapTotal: 8 * 1024 * 1024 },
    aggregate: {
      state: 'compatible',
      accountCount: 1,
      lastCheckAt: null,
      lastSuccessfulCheckAt: null,
      questCount: 2,
      supportedCount: 1,
      excludedCount: 0,
      questListPath: '/quests/@me',
      enrollmentBlockedUntil: null,
      unknownEvents: [],
      schemaIssues: [],
      lastVerifiedProgressAt: null,
      lastVerifiedCompletionAt: null,
      lastVerifiedClaimAt: null,
      lastError: null,
    },
    accountStatuses: [],
    jobs: [{ mode: 'oneshot' }, { mode: 'scheduled' }],
    persisted: [{ id: 1 }],
    activeDurable: [
      { state: 'RECOVERING' },
      { state: 'STOPPING' },
      { state: 'VERIFYING_ENROLLMENT' },
    ],
    activeRoles: ['control', 'worker'],
    workerHolders: new Set(['worker-a', 'worker-b']),
    activeClaims: [{ id: 1 }, { id: 2 }],
    transport: {
      apiVersion: 10,
      installed: true,
      rateLimit: {
        queued: 3,
        active: 1,
        rateLimited: 2,
        globalRateLimits: 1,
        knownRoutes: 4,
        knownScopes: 2,
        blockedBuckets: 1,
        openCircuits: 1,
        halfOpenCircuits: 0,
        checkpointErrors: 0,
        scheduleHintErrors: 0,
      },
    },
  }).toJSON();

  const fields = new Map(embed.fields.map((field) => [field.name, field.value]));
  assert.match(fields.get('Process Topology'), /Worker processes: \*\*2\*\*/);
  assert.match(fields.get('Process Topology'), /Scheduled claims: \*\*2\*\*/);
  assert.match(fields.get('Discord HTTP API v10'), /Queue: \*\*3\*\*/);
  assert.match(fields.get('Discord HTTP API v10'), /Circuits: \*\*1 open \/ 0 probe\*\*/);
  assert.match(fields.get('Runner'), /One-shot ใน Process นี้: \*\*1\*\*/);
  assert.match(fields.get('Runner'), /Auto Daily ใน Process นี้: \*\*1\*\*/);
  assert.match(fields.get('Runner'), /Recovering: \*\*1\*\*/);
  assert.match(fields.get('Runner'), /Stopping: \*\*1\*\*/);
  assert.match(fields.get('Runner'), /Verifying mutation: \*\*1\*\*/);
});
