import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../src/db.js';
import {
  executeVerifiedMutation,
  RunnerCheckpointError,
} from '../src/mutation-retry.js';
import { runWithRunnerExecutionContext } from '../src/quest/runner-execution-context.js';
import {
  beginRunnerState,
  getRunnerState,
  prepareRunnerMutation,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
} from '../src/quest/runner-state-store.js';

function networkFailure(message = 'response lost') {
  const error = new Error(message);
  error.code = 'ECONNRESET';
  return error;
}

test('lost response after a successful mutation is accepted from fresh server evidence', async () => {
  let mutations = 0;
  let verifications = 0;
  const result = await executeVerifiedMutation({
    perform: async () => {
      mutations++;
      throw networkFailure();
    },
    verify: async () => {
      verifications++;
      return true;
    },
    wait: async () => assert.fail('verified mutation must not wait or retry'),
  });

  assert.deepEqual(result, { verifiedAfterFailure: true });
  assert.equal(mutations, 1);
  assert.equal(verifications, 1);
});

test('uncertain mutation retries exactly once when fresh state proves it was not applied', async () => {
  let mutations = 0;
  let waits = 0;
  const result = await executeVerifiedMutation({
    perform: async () => {
      mutations++;
      if (mutations === 1) throw networkFailure();
      return { ok: true };
    },
    verify: async () => false,
    wait: async () => { waits++; },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(mutations, 2);
  assert.equal(waits, 1);
});

test('lost response after the controlled retry is accepted only after another verification', async () => {
  let mutations = 0;
  let verifications = 0;
  const result = await executeVerifiedMutation({
    perform: async () => {
      mutations++;
      throw networkFailure(`response lost ${mutations}`);
    },
    verify: async () => {
      verifications++;
      return verifications === 2;
    },
    wait: async () => {},
  });

  assert.deepEqual(result, { verifiedAfterFailure: true });
  assert.equal(mutations, 2);
  assert.equal(verifications, 2);
});

test('abort failures are terminal and never verify or retry', async () => {
  const error = new Error('aborted');
  error.name = 'AbortError';
  await assert.rejects(
    executeVerifiedMutation({
      perform: async () => { throw error; },
      verify: async () => assert.fail('abort must not verify'),
      wait: async () => assert.fail('abort must not wait'),
    }),
    (thrown) => thrown === error,
  );
});

for (const code of [
  'RUNNER_CHECKPOINT_FAILED',
  'RUNNER_MUTATION_CHECKPOINT_FAILED',
  'RUNNER_MUTATION_REQUIRES_VERIFICATION',
  'RUNNER_OWNERSHIP_LOST',
]) {
  test(`${code} is terminal and never enters mutation verification`, async () => {
    const error = new Error(code);
    error.code = code;
    await assert.rejects(
      executeVerifiedMutation({
        perform: async () => { throw error; },
        verify: async () => assert.fail(`${code} must not verify`),
        wait: async () => assert.fail(`${code} must not wait`),
      }),
      (thrown) => thrown === error,
    );
  });
}

for (const verificationAttempt of [1, 2]) {
  test(`verified checkpoint write failure on verification ${verificationAttempt} preserves uncertain evidence`, async () => {
    const jobKey = `scheduled:verified-write-failure-${verificationAttempt}`;
    const trigger = `fail_verified_checkpoint_${verificationAttempt}`;
    beginRunnerState({
      jobKey,
      ownerId: 'fault-owner',
      mode: 'scheduled',
      scheduleId: 9800 + verificationAttempt,
    });
    prepareRunnerMutation(jobKey, {
      kind: RUNNER_MUTATION_KIND.VIDEO_PROGRESS,
      questId: 'fault-quest',
      payload: { timestamp: 10 },
    });
    db.exec(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE OF mutation_status ON runner_states
      WHEN NEW.job_key = '${jobKey}' AND NEW.mutation_status = 'VERIFIED'
      BEGIN
        SELECT RAISE(FAIL, 'verified checkpoint unavailable');
      END;
    `);

    let verifications = 0;
    try {
      await assert.rejects(
        runWithRunnerExecutionContext({ jobKey }, () => executeVerifiedMutation({
          perform: async () => { throw networkFailure(); },
          verify: async () => {
            verifications++;
            return verifications >= verificationAttempt;
          },
          wait: async () => {},
        })),
        (error) => error instanceof RunnerCheckpointError
          && error.code === 'RUNNER_CHECKPOINT_FAILED'
          && error.stage === 'mark-verified',
      );
      const state = getRunnerState(jobKey);
      assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.UNCERTAIN);
      assert.notEqual(state.mutation_status, RUNNER_MUTATION_STATUS.FAILED);
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
  });
}
