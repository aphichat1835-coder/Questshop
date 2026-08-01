import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_COORDINATOR_STATE_PRUNE_INTERVAL_MS,
  DEFAULT_COORDINATOR_STATE_RETENTION_MS,
  DiscordRateLimitCoordinator,
} from '../src/quest/rate-limit-coordinator.js';

test('coordinator exposes bounded defaults for opportunistic memory pruning', () => {
  assert.equal(DEFAULT_COORDINATOR_STATE_PRUNE_INTERVAL_MS, 60_000);
  assert.equal(DEFAULT_COORDINATOR_STATE_RETENTION_MS, 10 * 60_000);
});

test('pruning removes expired resets, stale routes and idle circuits without touching live state', () => {
  let now = 100_000;
  const coordinator = new DiscordRateLimitCoordinator({
    now: () => now,
    statePruneIntervalMs: 0,
    stateRetentionMs: 1_000,
  });

  coordinator.routeBuckets.set('GET:/stale', 'bucket-stale');
  coordinator.routeScopes.set('GET:/stale', 'shared');
  coordinator.routeLastSeenAt.set('GET:/stale', now - 2_000);
  coordinator.routeBuckets.set('GET:/fresh', 'bucket-fresh');
  coordinator.routeScopes.set('GET:/fresh', 'user');
  coordinator.routeLastSeenAt.set('GET:/fresh', now);

  coordinator.bucketResetAt.set('expired-shared', now - 1);
  coordinator.bucketResetAt.set('future-shared', now + 5_000);
  coordinator.accountBucketResetAt.set('account:expired-user', now - 1);
  coordinator.accountBucketResetAt.set('account:future-user', now + 5_000);
  coordinator.globalResetAt = now - 1;

  coordinator.circuits.set('shared:closed-stale', {
    state: 'CLOSED',
    failures: 0,
    opens: 1,
    openUntil: 0,
    probeActive: false,
    lastTouchedAt: now - 2_000,
  });
  coordinator.circuits.set('shared:open-future', {
    state: 'OPEN',
    failures: 3,
    opens: 1,
    openUntil: now + 5_000,
    probeActive: false,
    lastTouchedAt: now - 2_000,
  });
  coordinator.circuits.set('shared:closed-fresh', {
    state: 'CLOSED',
    failures: 0,
    opens: 0,
    openUntil: 0,
    probeActive: false,
    lastTouchedAt: now,
  });

  const result = coordinator.pruneExpiredState({ force: true });
  assert.equal(result.skipped, false);
  assert.equal(coordinator.globalResetAt, 0);
  assert.equal(coordinator.bucketResetAt.has('expired-shared'), false);
  assert.equal(coordinator.bucketResetAt.has('future-shared'), true);
  assert.equal(coordinator.accountBucketResetAt.has('account:expired-user'), false);
  assert.equal(coordinator.accountBucketResetAt.has('account:future-user'), true);
  assert.equal(coordinator.routeBuckets.has('GET:/stale'), false);
  assert.equal(coordinator.routeScopes.has('GET:/stale'), false);
  assert.equal(coordinator.routeLastSeenAt.has('GET:/stale'), false);
  assert.equal(coordinator.routeBuckets.has('GET:/fresh'), true);
  assert.equal(coordinator.circuits.has('shared:closed-stale'), false);
  assert.equal(coordinator.circuits.has('shared:open-future'), true);
  assert.equal(coordinator.circuits.has('shared:closed-fresh'), true);

  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.knownRoutes, 1);
  assert.equal(snapshot.routeMetadataEntries, 1);
  assert.equal(snapshot.bucketResetEntries, 2);
  assert.equal(snapshot.circuitEntries, 2);
  assert.ok(snapshot.prunedEntries >= 5);
});

test('route and circuit metadata are protected while any work remains active or queued', () => {
  let now = 50_000;
  const coordinator = new DiscordRateLimitCoordinator({
    now: () => now,
    statePruneIntervalMs: 0,
    stateRetentionMs: 1_000,
  });
  const activeRoute = 'GET:/active';
  const queuedRoute = 'GET:/queued';

  for (const route of [activeRoute, queuedRoute]) {
    coordinator.routeBuckets.set(route, `bucket:${route}`);
    coordinator.routeScopes.set(route, 'shared');
    coordinator.routeLastSeenAt.set(route, now - 2_000);
  }
  coordinator.circuits.set('shared:stale-during-work', {
    state: 'CLOSED',
    failures: 0,
    opens: 0,
    openUntil: 0,
    probeActive: false,
    lastTouchedAt: now - 2_000,
  });
  coordinator.activeCount = 1;
  coordinator.queue.push({ route: queuedRoute });

  coordinator.pruneExpiredState({ force: true });
  assert.equal(coordinator.routeBuckets.has(activeRoute), true);
  assert.equal(coordinator.routeBuckets.has(queuedRoute), true);
  assert.equal(coordinator.circuits.has('shared:stale-during-work'), true);

  coordinator.activeCount = 0;
  coordinator.queue.length = 0;
  now += 1;
  coordinator.pruneExpiredState({ force: true });
  assert.equal(coordinator.routeBuckets.has(activeRoute), false);
  assert.equal(coordinator.routeBuckets.has(queuedRoute), false);
  assert.equal(coordinator.circuits.has('shared:stale-during-work'), false);
});

test('pruning is interval-gated unless explicitly forced', () => {
  let now = 10_000;
  const coordinator = new DiscordRateLimitCoordinator({
    now: () => now,
    statePruneIntervalMs: 1_000,
    stateRetentionMs: 100,
  });
  coordinator.routeBuckets.set('GET:/old', 'bucket-old');
  coordinator.routeScopes.set('GET:/old', 'shared');
  coordinator.routeLastSeenAt.set('GET:/old', now - 1_000);

  coordinator.pruneExpiredState({ force: true });
  coordinator.routeBuckets.set('GET:/second-old', 'bucket-second-old');
  coordinator.routeScopes.set('GET:/second-old', 'shared');
  coordinator.routeLastSeenAt.set('GET:/second-old', now - 1_000);

  assert.equal(coordinator.pruneExpiredState().skipped, true);
  assert.equal(coordinator.routeBuckets.has('GET:/second-old'), true);

  now += 1_000;
  assert.equal(coordinator.pruneExpiredState().skipped, false);
  assert.equal(coordinator.routeBuckets.has('GET:/second-old'), false);
});
