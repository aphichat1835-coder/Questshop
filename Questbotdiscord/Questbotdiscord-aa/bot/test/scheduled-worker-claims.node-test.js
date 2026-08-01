import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireScheduledRunnerClaim,
  getScheduledRunnerClaim,
  listScheduledRunnerClaims,
  releaseScheduledRunnerClaim,
  releaseScheduledRunnerClaimsByHolder,
  renewScheduledRunnerClaim,
} from '../src/quest/scheduled-worker-claims.js';

test('only one worker can own a scheduled row before its lease expires', () => {
  const id = 9301;
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  assert.equal(acquireScheduledRunnerClaim(id, 'worker-claim-a', 10_000, now), true);
  assert.equal(acquireScheduledRunnerClaim(id, 'worker-claim-b', 10_000, now + 1), false);
  assert.equal(getScheduledRunnerClaim(id, now + 1).holder, 'worker-claim-a');
  assert.equal(releaseScheduledRunnerClaim(id, 'worker-claim-a'), true);
});

test('the owner renews its claim and another worker can take over after expiry', () => {
  const id = 9302;
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  assert.equal(acquireScheduledRunnerClaim(id, 'worker-renew-a', 10_000, now), true);
  assert.equal(renewScheduledRunnerClaim(id, 'worker-renew-a', 10_000, now + 5_000), true);
  assert.equal(renewScheduledRunnerClaim(id, 'worker-renew-b', 10_000, now + 5_000), false);
  assert.equal(acquireScheduledRunnerClaim(id, 'worker-renew-b', 10_000, now + 14_999), false);
  assert.equal(acquireScheduledRunnerClaim(id, 'worker-renew-b', 10_000, now + 15_001), true);
  assert.equal(getScheduledRunnerClaim(id, now + 15_001).holder, 'worker-renew-b');
  assert.equal(releaseScheduledRunnerClaim(id, 'worker-renew-b'), true);
});

test('worker shutdown releases every row owned by that holder only', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  acquireScheduledRunnerClaim(9303, 'worker-shutdown-a', 10_000, now);
  acquireScheduledRunnerClaim(9304, 'worker-shutdown-a', 10_000, now);
  acquireScheduledRunnerClaim(9305, 'worker-shutdown-b', 10_000, now);

  assert.equal(releaseScheduledRunnerClaimsByHolder('worker-shutdown-a'), 2);
  assert.deepEqual(
    listScheduledRunnerClaims({ holder: 'worker-shutdown-a', now }),
    [],
  );
  assert.equal(listScheduledRunnerClaims({ holder: 'worker-shutdown-b', now }).length, 1);
  assert.equal(releaseScheduledRunnerClaim(9305, 'worker-shutdown-b'), true);
});
