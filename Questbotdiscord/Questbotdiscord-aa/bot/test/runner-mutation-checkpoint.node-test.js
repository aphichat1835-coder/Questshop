import './setup-env.js';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';
import {
  beginRunnerState,
  ensureRunnerStateSchema,
  getRunnerState,
  incrementRunnerRetry,
  markRunnerMutationAccepted,
  markRunnerMutationInFlight,
  markRunnerMutationUncertain,
  markRunnerMutationVerified,
  prepareRunnerMutation,
  RUNNER_ERROR_CATEGORY,
  RUNNER_MUTATION_KIND,
  RunnerMutationPendingVerificationError,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
} from '../src/quest/runner-state-store.js';

test('durable mutation checkpoint follows prepared through verified lifecycle', () => {
  beginRunnerState({
    jobKey: 'scheduled:checkpoint',
    ownerId: 'owner-1',
    mode: 'scheduled',
    scheduleId: 1,
  });

  prepareRunnerMutation('scheduled:checkpoint', {
    kind: RUNNER_MUTATION_KIND.VIDEO_PROGRESS,
    questId: 'quest-1',
    questName: 'Quest One',
    questEvent: 'WATCH_VIDEO',
    payload: {
      timestamp: 30,
      terminal: false,
      authorization: 'must-not-persist',
      captcha_key: 'must-not-persist',
    },
  });
  let state = getRunnerState('scheduled:checkpoint');
  assert.equal(state.state, RUNNER_STATE.RUNNING_PROGRESS);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.PREPARED);
  assert.deepEqual(state.mutation_payload, { timestamp: 30, terminal: false });

  markRunnerMutationInFlight('scheduled:checkpoint', new Date('2030-01-01T00:00:00.000Z'));
  state = getRunnerState('scheduled:checkpoint');
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.IN_FLIGHT);
  assert.equal(state.mutation_attempted_at, '2030-01-01T00:00:00.000Z');

  markRunnerMutationAccepted('scheduled:checkpoint', new Date('2030-01-01T00:00:01.000Z'));
  state = getRunnerState('scheduled:checkpoint');
  assert.equal(state.state, RUNNER_STATE.VERIFYING_PROGRESS);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.ACCEPTED);

  markRunnerMutationVerified('scheduled:checkpoint', {
    progress: 50,
    serverProgressSeconds: 30,
    now: new Date('2030-01-01T00:00:02.000Z'),
  });
  state = getRunnerState('scheduled:checkpoint');
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.VERIFIED);
  assert.equal(state.progress, 50);
  assert.equal(state.server_progress_seconds, 30);
  assert.equal(state.mutation_verified_at, '2030-01-01T00:00:02.000Z');
});

test('unverified checkpoint cannot be overwritten by another mutation', () => {
  const jobKey = 'scheduled:checkpoint-barrier';
  beginRunnerState({ jobKey, ownerId: 'owner-1', mode: 'scheduled', scheduleId: 2 });

  const prepareNext = () => prepareRunnerMutation(jobKey, {
    kind: RUNNER_MUTATION_KIND.HEARTBEAT,
    questId: 'quest-2',
    payload: { terminal: false },
  });
  const assertBlocked = (status) => assert.throws(
    prepareNext,
    (error) => (
      error instanceof RunnerMutationPendingVerificationError
      && error.code === 'RUNNER_MUTATION_REQUIRES_VERIFICATION'
      && error.mutationStatus === status
    ),
  );

  prepareRunnerMutation(jobKey, {
    kind: RUNNER_MUTATION_KIND.VIDEO_PROGRESS,
    questId: 'quest-1',
    payload: { timestamp: 10 },
  });
  assertBlocked(RUNNER_MUTATION_STATUS.PREPARED);

  markRunnerMutationInFlight(jobKey, new Date('2030-01-01T00:00:00.000Z'));
  assertBlocked(RUNNER_MUTATION_STATUS.IN_FLIGHT);

  markRunnerMutationAccepted(jobKey, new Date('2030-01-01T00:00:01.000Z'));
  assertBlocked(RUNNER_MUTATION_STATUS.ACCEPTED);

  markRunnerMutationUncertain(jobKey, new Error('fresh verification unavailable'));
  assertBlocked(RUNNER_MUTATION_STATUS.UNCERTAIN);

  markRunnerMutationVerified(jobKey, {
    serverProgressSeconds: 10,
    now: new Date('2030-01-01T00:00:02.000Z'),
  });
  assert.doesNotThrow(prepareNext);

  const state = getRunnerState(jobKey);
  assert.equal(state.quest_id, 'quest-2');
  assert.equal(state.mutation_kind, RUNNER_MUTATION_KIND.HEARTBEAT);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.PREPARED);
});

test('prepare mutation rejects a missing kind before persisting any checkpoint', () => {
  const jobKey = 'scheduled:checkpoint-missing-kind';
  beginRunnerState({ jobKey, ownerId: 'owner-1', mode: 'scheduled', scheduleId: 3 });

  assert.throws(
    () => prepareRunnerMutation(jobKey, { questId: 'quest-missing-kind' }),
    /Unknown runner mutation kind: undefined/,
  );
  const state = getRunnerState(jobKey);
  assert.equal(state.mutation_kind, null);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.NONE);
  assert.equal(state.quest_id, null);
});

test('uncertain mutation records error category without losing checkpoint details', () => {
  beginRunnerState({ jobKey: 'scheduled:uncertain', ownerId: 'owner-1', mode: 'scheduled' });
  prepareRunnerMutation('scheduled:uncertain', {
    kind: RUNNER_MUTATION_KIND.CLAIM,
    questId: 'quest-claim',
    payload: { platform: 4 },
  });
  const error = Object.assign(new Error('rate limited'), { status: 429 });
  markRunnerMutationUncertain('scheduled:uncertain', error, new Date('2030-01-01T00:00:00.000Z'));
  incrementRunnerRetry('scheduled:uncertain');

  const state = getRunnerState('scheduled:uncertain');
  assert.equal(state.state, RUNNER_STATE.VERIFYING_CLAIM);
  assert.equal(state.mutation_status, RUNNER_MUTATION_STATUS.UNCERTAIN);
  assert.equal(state.error_category, RUNNER_ERROR_CATEGORY.RATE_LIMIT);
  assert.equal(state.quest_id, 'quest-claim');
  assert.deepEqual(state.mutation_payload, { platform: 4 });
  assert.equal(state.retry_count, 1);
});

test('additive migration upgrades the previous runner_states schema without deleting rows', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE runner_states (
      job_key TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      account_id TEXT,
      username TEXT,
      mode TEXT NOT NULL,
      schedule_id INTEGER,
      state TEXT NOT NULL,
      quest_id TEXT,
      quest_name TEXT,
      progress REAL,
      next_action_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      metadata_json TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    INSERT INTO runner_states (job_key, owner_id, mode, state)
    VALUES ('scheduled:legacy', 'owner-1', 'scheduled', 'RUNNING');
  `);

  const columns = ensureRunnerStateSchema(database);
  assert.equal(columns.has('mutation_status'), true);
  assert.equal(columns.has('checkpoint_version'), true);
  const row = database.prepare(
    'SELECT job_key, mutation_status, checkpoint_version FROM runner_states WHERE job_key = ?',
  ).get('scheduled:legacy');
  assert.equal(row.job_key, 'scheduled:legacy');
  assert.equal(row.mutation_status, RUNNER_MUTATION_STATUS.NONE);
  assert.equal(row.checkpoint_version, 2);
  database.close();
});
