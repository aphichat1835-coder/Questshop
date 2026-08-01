import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { settleWithTimeout } from '../src/async-settle.js';

test('settleWithTimeout accepts a Set iterable and waits for every task', async () => {
  const tasks = new Set([
    Promise.resolve('first'),
    Promise.resolve('second'),
  ]);
  const results = await settleWithTimeout(tasks);
  assert.deepEqual(results.map((result) => result.value), ['first', 'second']);
});

test('settleWithTimeout reports the current number of pending tasks on timeout', async () => {
  const pending = new Set([new Promise(() => {})]);
  await assert.rejects(
    settleWithTimeout(pending, 5, {
      pendingCount: () => pending.size,
      timeoutMessage: (count) => `still waiting for ${count}`,
    }),
    /still waiting for 1/,
  );
});

test('settleWithTimeout does not report a timeout after tasks finish', async () => {
  const pending = new Set();
  const task = new Promise((resolve) => setTimeout(resolve, 5));
  pending.add(task);
  void task.finally(() => pending.delete(task));
  await settleWithTimeout(pending, 100, {
    pendingCount: () => pending.size,
    timeoutMessage: (count) => `unexpected ${count}`,
  });
  assert.equal(pending.size, 0);
});

test('runner quality refactor keeps static-analysis regressions out', async () => {
  const runner = await readFile(new URL('../src/discord-runner.js', import.meta.url), 'utf8');
  const videoExecutor = await readFile(
    new URL('../src/quest/executors/video-executor.js', import.meta.url),
    'utf8',
  );
  const worker = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
  const httpRetry = await readFile(new URL('../src/http-retry.js', import.meta.url), 'utf8');
  const mutationRetry = await readFile(new URL('../src/mutation-retry.js', import.meta.url), 'utf8');
  const stopCommand = await readFile(new URL('../src/commands/stop.js', import.meta.url), 'utf8');
  const db = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');
  const errorReporter = await readFile(new URL('../src/error-reporter.js', import.meta.url), 'utf8');
  const incidentCatalog = await readFile(new URL('../src/incident-catalog.js', import.meta.url), 'utf8');
  const webhookDelivery = await readFile(new URL('../src/webhook-delivery.js', import.meta.url), 'utf8');
  const backupPathsTest = await readFile(new URL('./backup-paths.node-test.js', import.meta.url), 'utf8');
  const auditHardeningTest = await readFile(new URL('./audit-hardening.node-test.js', import.meta.url), 'utf8');

  assert.doesNotMatch(runner, /Promise\.allSettled\(\[\.\.\.activeRunPromises\]\)/);
  assert.doesNotMatch(worker, /Promise\.allSettled\(\[\.\.\.activeTasks\]\)/);
  assert.match(runner, /settleWithTimeout\(activeRunPromises,/);
  assert.match(worker, /settleWithTimeout\(activeTasks,/);

  const startRunnerIndex = runner.indexOf('export async function startRunner');
  assert.ok(startRunnerIndex > 0);
  assert.ok(runner.indexOf('function oneShotFreshQuestFailureReason', 0) < startRunnerIndex);
  assert.ok(runner.indexOf('function oneShotUnavailableReason', 0) < startRunnerIndex);
  const helperDeclarations = runner.match(
    /function (idleQuestOutcome|attemptedQuestOutcome)\(/g,
  ) ?? [];
  for (const helperName of ['idleQuestOutcome', 'attemptedQuestOutcome']) {
    assert.equal(
      helperDeclarations.filter(
        (declaration) => declaration === `function ${helperName}(`,
      ).length,
      1,
    );
    assert.ok(runner.indexOf(`function ${helperName}`, 0) < startRunnerIndex);
  }

  assert.match(runner, /function prepareQuestRound\(/);
  assert.match(runner, /async function refreshRoundQuest\(/);
  assert.match(runner, /async function ensureQuestEnrollment\(/);
  assert.match(runner, /async function verifyQuestCompletion\(/);
  assert.doesNotMatch(runner, /function nextVideoTimestamp\(/);
  assert.doesNotMatch(runner, /async function submitVideoProgressStep\(/);
  assert.match(videoExecutor, /export function nextVideoTimestamp\(/);
  assert.match(videoExecutor, /async function submitProgress\(/);
  assert.match(videoExecutor, /export async function executeVideoQuest\(/);
  const executeProgressIndex = runner.indexOf('async function executeQuestProgress');
  const abortAfterRunnerIndex = runner.indexOf(
    "if (signal.aborted) throw new Error('aborted');",
    executeProgressIndex,
  );
  const executeProgressEnd = runner.indexOf(
    'async function verifyQuestCompletion',
    executeProgressIndex,
  );
  assert.ok(abortAfterRunnerIndex > executeProgressIndex);
  assert.ok(abortAfterRunnerIndex < executeProgressEnd);

  assert.doesNotMatch(runner, /process\.env\.DISCORD_(?:CLIENT|CHROME|ELECTRON|BUILD|NATIVE)/);
  assert.equal((runner.match(/async function questFailureOutcome/g) ?? []).length, 1);
  assert.doesNotMatch(runner, /verificationFailureOutcome|enrollmentFailureOutcome/);
  assert.match(httpRetry, /abortableDelay\(ms, signal\)/);
  assert.match(mutationRetry, /abortableDelay\(ms, signal, \{ unref: true \}\)/);
  assert.doesNotMatch(stopCommand, /function summarizeStopResults/);
  assert.match(db, /resolveDatabaseBackupSlotPath/);
  assert.match(db, /LOCAL_BACKUP_PROFILE/);
  assert.match(db, /PERSISTENT_BACKUP_PROFILE/);
  assert.match(db, /validateBackupProfile/);
  assert.doesNotMatch(db, /questbot-slot-\$\{/);
  assert.doesNotMatch(db, /DATABASE_BACKUP_DIR/);
  assert.doesNotMatch(db, /backupLocalSlot|backupPersistentSlot|clearLocalInactiveSlots|clearPersistentInactiveSlots/);
  assert.doesNotMatch(backupPathsTest, /os\.tmpdir|mkdtemp|node:path|\/tmp\/questbot\.db/);
  assert.doesNotMatch(backupPathsTest, /\.backup-path-workspaces|fs\.readFile\(new URL/);
  assert.match(backupPathsTest, /fs\.mkdir\('\.\/test\/\.backup-path-workspace'/);
  assert.match(backupPathsTest, /cwd: '\.\/test\/\.backup-path-workspace'/);
  assert.doesNotMatch(auditHardeningTest, /140\.1\.2\.3/);

  assert.match(errorReporter, /function incidentIdentity\(code, scope\)/);
  assert.match(errorReporter, /state = 'delivering'/);
  assert.match(errorReporter, /export async function reportIncident/);
  assert.match(errorReporter, /export async function reportRecovery/);
  assert.match(errorReporter, /allowlistedIncidentContext/);
  assert.match(incidentCatalog, /export const INCIDENT/);
  assert.match(incidentCatalog, /Object\.hasOwn\(DEFINITIONS, code\)/);
  assert.match(incidentCatalog, /export function allowlistedIncidentContext/);
  assert.match(webhookDelivery, /redirect: 'error'/);
  assert.match(webhookDelivery, /RETRYABLE_STATUSES/);
  assert.doesNotMatch(webhookDelivery, /status\s*>=\s*500/);

  assert.match(httpRetry, /async function consumeRetryableResponse/);
  assert.match(httpRetry, /async function handleFetchFailure/);
});
