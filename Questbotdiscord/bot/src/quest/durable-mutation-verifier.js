import { normalizeQuest } from './schema/normalizer.js';
import {
  clearRunnerMutationCheckpoint,
  getRunnerState,
  markRunnerMutationFailed,
  markRunnerMutationVerified,
  RUNNER_MUTATION_KIND,
  RUNNER_STATE,
} from './runner-state-store.js';

export const RUNNER_MUTATION_EVIDENCE = Object.freeze({
  NO_CHECKPOINT: 'NO_CHECKPOINT',
  VERIFIED: 'VERIFIED',
  NOT_APPLIED: 'NOT_APPLIED',
  QUEST_MISSING: 'QUEST_MISSING',
  QUEST_EXPIRED: 'QUEST_EXPIRED',
  QUEST_INCOMPATIBLE: 'QUEST_INCOMPATIBLE',
  COMPLETED: 'COMPLETED',
  CLAIMED: 'CLAIMED',
});

const PROGRESS_MUTATION_KINDS = new Set([
  RUNNER_MUTATION_KIND.VIDEO_PROGRESS,
  RUNNER_MUTATION_KIND.HEARTBEAT,
]);

function rawUserStatus(quest) {
  return quest?.user_status ?? null;
}

function finiteProgress(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function nestedProgress(value) {
  const direct = finiteProgress(value);
  if (direct != null) return direct;
  if (!value || typeof value !== 'object') return 0;
  if (Object.hasOwn(value, 'value')) return nestedProgress(value.value);
  const values = Object.values(value).map(nestedProgress);
  return values.length ? Math.max(0, ...values) : 0;
}

function directProgressSeconds(quest) {
  return finiteProgress(quest?.progressSecs);
}

function hasTaskDefinitions(quest) {
  const tasks = quest?.config?.task_config_v2?.tasks
    ?? quest?.config?.task_config?.tasks;
  return Boolean(tasks && typeof tasks === 'object' && !Array.isArray(tasks));
}

function alreadyNormalizedQuest(quest) {
  return Boolean(quest && directProgressSeconds(quest) != null);
}

function normalizedQuestForState(state, quest) {
  if (!quest) return null;
  if (alreadyNormalizedQuest(quest)) return quest;
  if (!hasTaskDefinitions(quest)) return null;
  try {
    return normalizeQuest(quest, {
      preferredEventName: state?.quest_event ?? null,
      preferredProgressKey: state?.metadata?.progressKey ?? null,
    });
  } catch {
    return null;
  }
}

function rawProgressForState(quest, state) {
  const status = rawUserStatus(quest) ?? {};
  const progress = status.progress;
  if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
    const preferredKeys = [
      state?.metadata?.progressKey,
      state?.quest_event,
    ].filter(Boolean);
    for (const key of preferredKeys) {
      if (Object.hasOwn(progress, key)) return nestedProgress(progress[key]);
    }
    // Legacy or partial fixtures may not carry a task definition/event mapping.
    // Use the aggregate only when no exact persisted task key can be selected.
    return nestedProgress(progress);
  }
  const scalar = finiteProgress(progress);
  if (scalar != null) return scalar;
  return finiteProgress(status.stream_progress_seconds) ?? 0;
}

export function questServerProgressSeconds(quest, state = null) {
  const direct = directProgressSeconds(quest);
  if (direct != null) return direct;
  const normalized = normalizedQuestForState(state, quest);
  const normalizedProgress = directProgressSeconds(normalized);
  if (normalizedProgress != null) return normalizedProgress;
  return rawProgressForState(quest, state);
}

function questEnrolled(quest) {
  if (typeof quest?.enrolled === 'boolean') return quest.enrolled;
  return Boolean(rawUserStatus(quest)?.enrolled_at);
}

function questClaimed(quest) {
  if (typeof quest?.claimed === 'boolean') return quest.claimed;
  const status = rawUserStatus(quest) ?? {};
  return Boolean(status.claimed_at) || status.orb_quantity_claimed != null;
}

function questCompleted(quest) {
  if (typeof quest?.completed === 'boolean') return quest.completed;
  return Boolean(rawUserStatus(quest)?.completed_at);
}

function questExpiresAt(quest) {
  return quest?.expiresAt ?? quest?.config?.expires_at ?? null;
}

function questExpired(quest, now) {
  const expiresAt = Date.parse(questExpiresAt(quest));
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

function explicitCompatibilityIssue(quest) {
  return quest?.autoSupported === false
    || (Array.isArray(quest?.compatibilityIssues) && quest.compatibilityIssues.length > 0)
    || (Array.isArray(quest?.schemaIssues) && quest.schemaIssues.length > 0);
}

function progressQuestIncompatible(quest, normalizedQuest) {
  if (explicitCompatibilityIssue(quest)) return true;
  if (!hasTaskDefinitions(quest)) return false;
  if (!normalizedQuest || normalizedQuest.autoSupported === false) return true;
  return (
    Array.isArray(normalizedQuest.compatibilityIssues)
    && normalizedQuest.compatibilityIssues.length > 0
  ) || (
    Array.isArray(normalizedQuest.schemaIssues)
    && normalizedQuest.schemaIssues.length > 0
  );
}

export function isRunnerMutationVerifiedByQuest(state, quest) {
  if (!state?.mutation_kind || !quest) return false;
  if (state.mutation_kind === RUNNER_MUTATION_KIND.ENROLL) return questEnrolled(quest);
  if (state.mutation_kind === RUNNER_MUTATION_KIND.CLAIM) return questClaimed(quest);
  if (questCompleted(quest)) return true;

  const progress = questServerProgressSeconds(quest, state);
  if (state.mutation_kind === RUNNER_MUTATION_KIND.VIDEO_PROGRESS) {
    const target = Number(state.mutation_payload?.timestamp);
    return Number.isFinite(target) && progress >= Math.floor(target);
  }
  if (state.mutation_kind === RUNNER_MUTATION_KIND.HEARTBEAT) {
    return progress > Number(state.server_progress_seconds ?? 0);
  }
  return false;
}

export function evaluateRunnerMutationEvidence(state, quests, now = new Date()) {
  if (!state?.quest_id || !state.mutation_kind) {
    return {
      outcome: RUNNER_MUTATION_EVIDENCE.NO_CHECKPOINT,
      quest: null,
      normalizedQuest: null,
    };
  }

  const quest = (quests ?? []).find((item) => String(item?.id) === String(state.quest_id)) ?? null;
  if (!quest) {
    return {
      outcome: RUNNER_MUTATION_EVIDENCE.QUEST_MISSING,
      quest: null,
      normalizedQuest: null,
    };
  }
  const normalizedQuest = PROGRESS_MUTATION_KINDS.has(state.mutation_kind)
    ? normalizedQuestForState(state, quest)
    : null;

  if (state.mutation_kind === RUNNER_MUTATION_KIND.CLAIM && questClaimed(quest)) {
    return { outcome: RUNNER_MUTATION_EVIDENCE.CLAIMED, quest, normalizedQuest };
  }
  if (state.mutation_kind !== RUNNER_MUTATION_KIND.CLAIM && questCompleted(quest)) {
    return { outcome: RUNNER_MUTATION_EVIDENCE.COMPLETED, quest, normalizedQuest };
  }
  if (isRunnerMutationVerifiedByQuest(state, quest)) {
    return { outcome: RUNNER_MUTATION_EVIDENCE.VERIFIED, quest, normalizedQuest };
  }
  if (questExpired(quest, now)) {
    return { outcome: RUNNER_MUTATION_EVIDENCE.QUEST_EXPIRED, quest, normalizedQuest };
  }
  if (
    PROGRESS_MUTATION_KINDS.has(state.mutation_kind)
    && progressQuestIncompatible(quest, normalizedQuest)
  ) {
    return { outcome: RUNNER_MUTATION_EVIDENCE.QUEST_INCOMPATIBLE, quest, normalizedQuest };
  }
  return { outcome: RUNNER_MUTATION_EVIDENCE.NOT_APPLIED, quest, normalizedQuest };
}

function evidenceError(outcome, questId) {
  const error = new Error(`Runner mutation recovery stopped: ${outcome} for Quest ${questId}`);
  error.name = outcome === RUNNER_MUTATION_EVIDENCE.QUEST_INCOMPATIBLE
    ? 'QuestCompatibilityError'
    : 'RunnerMutationEvidenceError';
  error.code = outcome;
  if ([
    RUNNER_MUTATION_EVIDENCE.QUEST_MISSING,
    RUNNER_MUTATION_EVIDENCE.QUEST_EXPIRED,
  ].includes(outcome)) {
    error.status = 410;
  }
  return error;
}

function verifiedStateFor(outcome, quest, fallback) {
  if (outcome === RUNNER_MUTATION_EVIDENCE.COMPLETED || questCompleted(quest)) {
    return RUNNER_STATE.VERIFYING_COMPLETION;
  }
  if (outcome === RUNNER_MUTATION_EVIDENCE.CLAIMED) return RUNNER_STATE.RUNNING;
  return fallback;
}

export function verifyRunnerMutationFromQuests(jobKey, quests, {
  verifiedState = RUNNER_STATE.RUNNING,
  absentState = RUNNER_STATE.RUNNING,
  finalizeAbsent = false,
  now = new Date(),
} = {}) {
  const state = getRunnerState(jobKey);
  const evidence = evaluateRunnerMutationEvidence(state, quests, now);
  const { outcome, quest, normalizedQuest } = evidence;

  if (outcome === RUNNER_MUTATION_EVIDENCE.NO_CHECKPOINT) {
    return { checked: false, verified: false, retryAllowed: false, ...evidence, state };
  }

  if ([
    RUNNER_MUTATION_EVIDENCE.VERIFIED,
    RUNNER_MUTATION_EVIDENCE.COMPLETED,
    RUNNER_MUTATION_EVIDENCE.CLAIMED,
  ].includes(outcome)) {
    const progressQuest = normalizedQuest ?? quest;
    const updated = markRunnerMutationVerified(jobKey, {
      serverProgressSeconds: questServerProgressSeconds(progressQuest, state),
      progress: Number.isFinite(Number(normalizedQuest?.progress))
        ? Number(normalizedQuest.progress)
        : undefined,
      state: verifiedStateFor(outcome, quest, verifiedState),
    });
    return {
      checked: true,
      verified: true,
      retryAllowed: false,
      ...evidence,
      state: updated,
    };
  }

  if (!finalizeAbsent) {
    return {
      checked: true,
      verified: false,
      retryAllowed: false,
      preserved: true,
      ...evidence,
      state,
    };
  }

  if (outcome === RUNNER_MUTATION_EVIDENCE.NOT_APPLIED) {
    const updated = clearRunnerMutationCheckpoint(jobKey, absentState);
    return {
      checked: true,
      verified: false,
      retryAllowed: true,
      ...evidence,
      state: updated,
    };
  }

  const updated = markRunnerMutationFailed(jobKey, evidenceError(outcome, state.quest_id), {
    state: absentState,
    nextActionAt: null,
  });
  return {
    checked: true,
    verified: false,
    retryAllowed: false,
    ...evidence,
    state: updated,
  };
}
