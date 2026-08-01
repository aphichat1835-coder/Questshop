import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchDurableRecoveryQuests } from '../src/quest/recovery-fetch.js';

test('transient durable recovery fetch failures are deferred into the normal runner loop', async () => {
  const deferred = [];
  const result = await fetchDurableRecoveryQuests({
    fetchQuests: async () => { throw new Error('temporary network outage'); },
    userToken: 'fixture-token',
    signal: new AbortController().signal,
    isFatalAuthError: () => false,
    onDeferred: async (error) => deferred.push(error.message),
  });

  assert.equal(result, null);
  assert.deepEqual(deferred, ['temporary network outage']);
});

test('durable recovery fetch preserves abort and fatal authentication failures', async () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await assert.rejects(
    fetchDurableRecoveryQuests({
      fetchQuests: async () => { throw abort; },
      userToken: 'fixture-token',
      signal: new AbortController().signal,
      isFatalAuthError: () => false,
    }),
    (error) => error === abort,
  );

  const fatal = Object.assign(new Error('Unauthorized'), { status: 401 });
  await assert.rejects(
    fetchDurableRecoveryQuests({
      fetchQuests: async () => { throw fatal; },
      userToken: 'expired-token',
      signal: new AbortController().signal,
      isFatalAuthError: (error) => error?.status === 401,
    }),
    (error) => error === fatal,
  );
});

test('a successful durable recovery fetch returns the fresh Quest list unchanged', async () => {
  const quests = [{ id: 'quest-recovery-policy' }];
  const result = await fetchDurableRecoveryQuests({
    fetchQuests: async () => quests,
    userToken: 'fixture-token',
    signal: new AbortController().signal,
    isFatalAuthError: () => false,
  });

  assert.equal(result, quests);
});
