import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationFingerprint } from '../src/quest/authorization-fingerprint.js';
import {
  clearRunnerExecutionContextsForTests,
  currentRunnerExecutionContext,
  registerRunnerExecution,
  resolveRunnerExecutionContext,
  resolveRunnerJobKey,
  runWithRunnerExecutionContext,
} from '../src/quest/runner-execution-context.js';

test.beforeEach(() => clearRunnerExecutionContextsForTests());

test('runner execution registry stores only authorization fingerprint mapping', async () => {
  const token = 'secret-user-token';
  const registration = registerRunnerExecution({
    jobKey: 'scheduled:1',
    ownerId: 'owner-1',
    userToken: token,
    mode: 'scheduled',
  });

  assert.equal(resolveRunnerJobKey(authorizationFingerprint(token)), 'scheduled:1');
  assert.equal(JSON.stringify(registration.context).includes(token), false);

  const observed = await runWithRunnerExecutionContext(registration.context, async () => {
    await Promise.resolve();
    return currentRunnerExecutionContext();
  });
  assert.equal(observed.jobKey, 'scheduled:1');
  assert.equal(observed.accountKey, authorizationFingerprint(token));

  assert.equal(registration.release(), true);
  assert.equal(resolveRunnerJobKey(authorizationFingerprint(token)), null);
  assert.equal(registration.release(), false);
});

test('re-registering one job with a new account removes its stale fingerprint mapping', () => {
  const first = registerRunnerExecution({
    jobKey: 'scheduled:replace',
    ownerId: 'owner-1',
    userToken: 'old-account-token',
    mode: 'scheduled',
  });
  const second = registerRunnerExecution({
    jobKey: 'scheduled:replace',
    ownerId: 'owner-1',
    userToken: 'new-account-token',
    mode: 'scheduled',
  });

  assert.equal(resolveRunnerJobKey(authorizationFingerprint('old-account-token')), null);
  assert.equal(
    resolveRunnerJobKey(authorizationFingerprint('new-account-token')),
    'scheduled:replace',
  );
  assert.equal(resolveRunnerExecutionContext('scheduled:replace').accountKey, second.context.accountKey);

  first.release();
  assert.equal(
    resolveRunnerJobKey(authorizationFingerprint('new-account-token')),
    'scheduled:replace',
  );
  second.release();
  assert.equal(resolveRunnerJobKey(authorizationFingerprint('new-account-token')), null);
});

test('re-registering one job without a token removes its previous account mapping', () => {
  const first = registerRunnerExecution({
    jobKey: 'scheduled:tokenless-replace',
    userToken: 'previous-token',
  });
  const second = registerRunnerExecution({ jobKey: 'scheduled:tokenless-replace' });

  assert.equal(resolveRunnerJobKey(authorizationFingerprint('previous-token')), null);
  assert.equal(second.context.accountKey, null);
  first.release();
  second.release();
});

test('tokenless test contexts do not collide through the anonymous fingerprint', () => {
  const first = registerRunnerExecution({ jobKey: 'test:1', ownerId: 'owner-1' });
  const second = registerRunnerExecution({ jobKey: 'test:2', ownerId: 'owner-1' });
  assert.equal(first.context.accountKey, null);
  assert.equal(second.context.accountKey, null);
  first.release();
  second.release();
});

test('every missing authorization form uses one anonymous fingerprint bucket', () => {
  const expected = authorizationFingerprint('anonymous');
  assert.equal(authorizationFingerprint(), expected);
  assert.equal(authorizationFingerprint(null), expected);
  assert.equal(authorizationFingerprint({}), expected);
  assert.equal(authorizationFingerprint(new Headers()), expected);
  assert.equal(authorizationFingerprint(''), expected);
});
