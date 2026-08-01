import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeOneShotQuest,
  createOneShotQuestSession,
  EXTERNAL_COMPLETION_REASON,
  failOneShotQuest,
  getNextPendingOneShotQuest,
  getOneShotQuest,
  getOneShotSessionSummary,
  hasOneShotQuest,
  isOneShotSessionComplete,
  markOneShotProgressMutationSent,
  markOneShotQuestRunning,
  ONE_SHOT_QUEST_STATUS,
  ONE_SHOT_REWARD_STATUS,
  recordOneShotRewardClaim,
  recordOneShotVerifiedProgress,
  REWARD_PENDING_REASON,
} from '../src/one-shot-quest-session.js';

function quest(id, progressSecs = 0) {
  return {
    id,
    name: `Quest ${id.toUpperCase()}`,
    eventName: 'WATCH_VIDEO',
    progressSecs,
  };
}

test('session locks the initial quest ids and preserves their order', () => {
  const session = createOneShotQuestSession([quest('a'), quest('b'), quest('a')]);

  assert.deepEqual(session.questOrder, ['a', 'b']);
  assert.equal(session.totalSupportedQuests, 2);
  assert.equal(hasOneShotQuest(session, 'a'), true);
  assert.equal(hasOneShotQuest(session, 'c'), false);
  assert.equal(getNextPendingOneShotQuest(session).id, 'a');
  assert.equal(getOneShotQuest(session, 'a').rewardStatus, ONE_SHOT_REWARD_STATUS.NOT_APPLICABLE);
});

test('bot completion and a confirmed claim are reported independently', () => {
  const session = createOneShotQuestSession([quest('a', 4)]);

  assert.equal(markOneShotQuestRunning(session, 'a', 5), true);
  assert.equal(markOneShotProgressMutationSent(session, 'a'), true);
  assert.equal(recordOneShotVerifiedProgress(session, 'a', 6), true);
  assert.equal(completeOneShotQuest(session, 'a'), ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT);
  assert.equal(getOneShotQuest(session, 'a').rewardStatus, ONE_SHOT_REWARD_STATUS.PENDING);
  assert.equal(recordOneShotRewardClaim(session, 'a', { claimed: true }), true);

  const summary = getOneShotSessionSummary(session);
  assert.equal(summary.completedByBotCount, 1);
  assert.equal(summary.completedExternalCount, 0);
  assert.equal(summary.claimedRewardCount, 1);
  assert.equal(summary.claimPendingCount, 0);
  assert.equal(summary.issues.length, 0);
  assert.equal(isOneShotSessionComplete(session), true);
});

test('a completed Quest with an unconfirmed claim remains visible as reward pending', () => {
  const session = createOneShotQuestSession([quest('a')]);

  markOneShotQuestRunning(session, 'a', 0);
  markOneShotProgressMutationSent(session, 'a');
  recordOneShotVerifiedProgress(session, 'a', 1);
  completeOneShotQuest(session, 'a');
  assert.equal(recordOneShotRewardClaim(session, 'a', { claimed: false }), true);

  const summary = getOneShotSessionSummary(session);
  assert.equal(summary.completedByBotCount, 1);
  assert.equal(summary.claimedRewardCount, 0);
  assert.equal(summary.claimPendingCount, 1);
  assert.deepEqual(summary.issues, [{
    id: 'a',
    name: 'Quest A',
    reason: REWARD_PENDING_REASON,
  }]);
});

test('a completion without verified bot progress is external while claim status stays accurate', () => {
  const session = createOneShotQuestSession([quest('a')]);

  assert.equal(completeOneShotQuest(session, 'a'), ONE_SHOT_QUEST_STATUS.COMPLETED_EXTERNAL);
  assert.equal(getOneShotQuest(session, 'a').reason, EXTERNAL_COMPLETION_REASON);
  assert.equal(recordOneShotRewardClaim(session, 'a', { claimed: true }), true);

  const summary = getOneShotSessionSummary(session);
  assert.equal(summary.completedByBotCount, 0);
  assert.equal(summary.completedExternalCount, 1);
  assert.equal(summary.claimedRewardCount, 1);
  assert.equal(summary.claimPendingCount, 0);
  assert.deepEqual(summary.issues, [{
    id: 'a',
    name: 'Quest A',
    reason: EXTERNAL_COMPLETION_REASON,
  }]);
});

test('external completion and pending reward reasons remain distinguishable', () => {
  const session = createOneShotQuestSession([quest('a')]);
  completeOneShotQuest(session, 'a');
  recordOneShotRewardClaim(session, 'a', { claimed: false });

  assert.deepEqual(getOneShotSessionSummary(session).issues, [{
    id: 'a',
    name: 'Quest A',
    reason: `${EXTERNAL_COMPLETION_REASON} — ${REWARD_PENDING_REASON}`,
  }]);
});

test('pre-existing progress is moved into the baseline before bot attribution', () => {
  const session = createOneShotQuestSession([quest('a', 1)]);

  markOneShotQuestRunning(session, 'a', 7);
  markOneShotProgressMutationSent(session, 'a');
  assert.equal(recordOneShotVerifiedProgress(session, 'a', 7), false);
  assert.equal(recordOneShotVerifiedProgress(session, 'a', 8), true);
  assert.equal(completeOneShotQuest(session, 'a'), ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT);
});

test('accepted mutation may prove an immediate completion', () => {
  const session = createOneShotQuestSession([quest('a')]);

  markOneShotQuestRunning(session, 'a', 0);
  markOneShotProgressMutationSent(session, 'a');
  assert.equal(recordOneShotVerifiedProgress(session, 'a', 0, { completed: true }), true);
  assert.equal(completeOneShotQuest(session, 'a'), ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT);
});

test('reward status cannot be written before Quest completion', () => {
  const session = createOneShotQuestSession([quest('a')]);
  assert.equal(recordOneShotRewardClaim(session, 'a', { claimed: true }), false);
  assert.equal(getOneShotQuest(session, 'a').rewardStatus, ONE_SHOT_REWARD_STATUS.NOT_APPLICABLE);
});

test('failure is terminal, ordered and cannot be overwritten by completion or reward claim', () => {
  const session = createOneShotQuestSession([quest('a'), quest('b')]);

  assert.equal(failOneShotQuest(session, 'a', 'Discord ยังไม่ยืนยันสถานะเสร็จ'), true);
  assert.equal(failOneShotQuest(session, 'a', 'duplicate'), false);
  assert.equal(completeOneShotQuest(session, 'a'), ONE_SHOT_QUEST_STATUS.FAILED);
  assert.equal(recordOneShotRewardClaim(session, 'a', { claimed: true }), false);
  assert.equal(getNextPendingOneShotQuest(session).id, 'b');

  const summary = getOneShotSessionSummary(session);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.claimedRewardCount, 0);
  assert.equal(summary.claimPendingCount, 0);
  assert.deepEqual(summary.issues, [{
    id: 'a',
    name: 'Quest A',
    reason: 'Discord ยังไม่ยืนยันสถานะเสร็จ',
  }]);
});
