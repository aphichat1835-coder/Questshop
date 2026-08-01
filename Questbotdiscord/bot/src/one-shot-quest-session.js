export const ONE_SHOT_QUEST_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED_BY_BOT: 'completed_by_bot',
  COMPLETED_EXTERNAL: 'completed_external',
  FAILED: 'failed',
});

export const ONE_SHOT_REWARD_STATUS = Object.freeze({
  NOT_APPLICABLE: 'not_applicable',
  PENDING: 'pending',
  CLAIMED: 'claimed',
});

export const EXTERNAL_COMPLETION_REASON = 'Quest เสร็จจากภายนอก จึงไม่นับเป็น Quest ที่บอททำ';
export const REWARD_PENDING_REASON = 'Quest เสร็จแล้ว แต่ยังรับรางวัลไม่สำเร็จ';

const TERMINAL_STATUSES = new Set([
  ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT,
  ONE_SHOT_QUEST_STATUS.COMPLETED_EXTERNAL,
  ONE_SHOT_QUEST_STATUS.FAILED,
]);

function normalizeProgress(value) {
  const progress = Number(value);
  return Number.isFinite(progress) && progress >= 0 ? progress : 0;
}

function getRequiredQuest(session, questId) {
  const quest = session?.quests?.get(questId);
  if (!quest) throw new Error(`Quest ${questId} is not part of this one-shot session`);
  return quest;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function isCompletedStatus(status) {
  return status === ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT
    || status === ONE_SHOT_QUEST_STATUS.COMPLETED_EXTERNAL;
}

export function createOneShotQuestSession(quests) {
  const questOrder = [];
  const questMap = new Map();

  for (const quest of quests ?? []) {
    const id = String(quest?.id ?? '').trim();
    if (!id || questMap.has(id)) continue;
    const initialProgressSecs = normalizeProgress(quest.progressSecs);
    questOrder.push(id);
    questMap.set(id, {
      id,
      name: String(quest.name || id),
      eventName: String(quest.eventName || 'UNKNOWN'),
      initialProgressSecs,
      lastVerifiedProgressSecs: initialProgressSecs,
      status: ONE_SHOT_QUEST_STATUS.PENDING,
      attemptStarted: false,
      progressMutationSent: false,
      botProgressVerified: false,
      reason: null,
      rewardStatus: ONE_SHOT_REWARD_STATUS.NOT_APPLICABLE,
      rewardReason: null,
    });
  }

  return {
    questOrder,
    quests: questMap,
    totalSupportedQuests: questOrder.length,
  };
}

export function hasOneShotQuest(session, questId) {
  return Boolean(session?.quests?.has(questId));
}

export function getOneShotQuest(session, questId) {
  return getRequiredQuest(session, questId);
}

export function getNextPendingOneShotQuest(session) {
  for (const questId of session?.questOrder ?? []) {
    const quest = session.quests.get(questId);
    if (quest?.status === ONE_SHOT_QUEST_STATUS.PENDING) return quest;
  }
  return null;
}

export function markOneShotQuestRunning(session, questId, progressSecs = null) {
  const quest = getRequiredQuest(session, questId);
  if (isTerminalStatus(quest.status)) return false;
  if (quest.status === ONE_SHOT_QUEST_STATUS.PENDING) {
    quest.status = ONE_SHOT_QUEST_STATUS.RUNNING;
    quest.attemptStarted = true;
  }
  const currentProgress = normalizeProgress(progressSecs);
  quest.initialProgressSecs = Math.max(quest.initialProgressSecs, currentProgress);
  quest.lastVerifiedProgressSecs = Math.max(quest.lastVerifiedProgressSecs, currentProgress);
  return true;
}

export function markOneShotProgressMutationSent(session, questId) {
  const quest = getRequiredQuest(session, questId);
  if (quest.status !== ONE_SHOT_QUEST_STATUS.RUNNING) return false;
  quest.progressMutationSent = true;
  return true;
}

export function recordOneShotVerifiedProgress(
  session,
  questId,
  progressSecs,
  { completed = false } = {},
) {
  const quest = getRequiredQuest(session, questId);
  if (quest.status !== ONE_SHOT_QUEST_STATUS.RUNNING || !quest.progressMutationSent) {
    return false;
  }

  const progress = normalizeProgress(progressSecs);
  const increased = progress > quest.lastVerifiedProgressSecs;
  if (!increased && !completed) return false;

  quest.lastVerifiedProgressSecs = Math.max(quest.lastVerifiedProgressSecs, progress);
  quest.botProgressVerified = true;
  return true;
}

export function completeOneShotQuest(session, questId) {
  const quest = getRequiredQuest(session, questId);
  if (isTerminalStatus(quest.status)) return quest.status;

  const completedByBot = quest.status === ONE_SHOT_QUEST_STATUS.RUNNING
    && quest.attemptStarted
    && quest.progressMutationSent
    && quest.botProgressVerified;

  quest.status = completedByBot
    ? ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT
    : ONE_SHOT_QUEST_STATUS.COMPLETED_EXTERNAL;
  quest.reason = completedByBot ? null : EXTERNAL_COMPLETION_REASON;
  quest.rewardStatus = ONE_SHOT_REWARD_STATUS.PENDING;
  quest.rewardReason = REWARD_PENDING_REASON;
  return quest.status;
}

export function recordOneShotRewardClaim(session, questId, {
  claimed,
  reason = REWARD_PENDING_REASON,
} = {}) {
  const quest = getRequiredQuest(session, questId);
  if (!isCompletedStatus(quest.status)) return false;
  quest.rewardStatus = claimed
    ? ONE_SHOT_REWARD_STATUS.CLAIMED
    : ONE_SHOT_REWARD_STATUS.PENDING;
  quest.rewardReason = claimed ? null : String(reason || REWARD_PENDING_REASON);
  return true;
}

export function failOneShotQuest(session, questId, reason) {
  const quest = getRequiredQuest(session, questId);
  if (isTerminalStatus(quest.status)) return false;
  quest.status = ONE_SHOT_QUEST_STATUS.FAILED;
  quest.reason = String(reason || 'ไม่สามารถดำเนินการ Quest ได้');
  quest.rewardStatus = ONE_SHOT_REWARD_STATUS.NOT_APPLICABLE;
  quest.rewardReason = null;
  return true;
}

function questIssue(quest) {
  const reasons = [];
  if (quest.reason) reasons.push(quest.reason);
  if (quest.rewardStatus === ONE_SHOT_REWARD_STATUS.PENDING && quest.rewardReason) {
    reasons.push(quest.rewardReason);
  }
  if (!reasons.length) return null;
  return {
    id: quest.id,
    name: quest.name,
    reason: reasons.join(' — '),
  };
}

export function getOneShotSessionSummary(session) {
  const summary = {
    totalSupportedQuests: session?.totalSupportedQuests ?? 0,
    completedByBotCount: 0,
    completedExternalCount: 0,
    failedCount: 0,
    pendingCount: 0,
    claimedRewardCount: 0,
    claimPendingCount: 0,
    issues: [],
  };

  for (const questId of session?.questOrder ?? []) {
    const quest = session.quests.get(questId);
    if (!quest) continue;
    switch (quest.status) {
      case ONE_SHOT_QUEST_STATUS.COMPLETED_BY_BOT:
        summary.completedByBotCount++;
        break;
      case ONE_SHOT_QUEST_STATUS.COMPLETED_EXTERNAL:
        summary.completedExternalCount++;
        break;
      case ONE_SHOT_QUEST_STATUS.FAILED:
        summary.failedCount++;
        break;
      default:
        summary.pendingCount++;
    }

    if (quest.rewardStatus === ONE_SHOT_REWARD_STATUS.CLAIMED) {
      summary.claimedRewardCount++;
    } else if (quest.rewardStatus === ONE_SHOT_REWARD_STATUS.PENDING) {
      summary.claimPendingCount++;
    }

    const issue = questIssue(quest);
    if (issue) summary.issues.push(issue);
  }
  return summary;
}

export function isOneShotSessionComplete(session) {
  return getOneShotSessionSummary(session).pendingCount === 0;
}
