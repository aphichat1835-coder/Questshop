import { selectQuestExecutor } from '../executors/registry.js';
import {
  assertQuestObject,
  questCompatibilityIssue,
  QuestCompatibilityError,
} from './compatibility.js';

function taskEntries(taskConfig) {
  const tasks = taskConfig?.tasks;
  return tasks && typeof tasks === 'object' && !Array.isArray(tasks) ? Object.entries(tasks) : [];
}

function eventType(key, definition) {
  return definition?.event_name ?? definition?.type ?? key;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function readProgress(status, task, target) {
  const progress = status?.progress;
  if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
    const value = progress[task.key] ?? progress[task.type];
    return finite(value?.value ?? value);
  }
  if (typeof progress === 'number' || typeof progress === 'string') {
    return (finite(progress) / 100) * target;
  }
  return finite(status?.stream_progress_seconds);
}

function chooseTask(entries, status, options) {
  const normalized = entries.map(([key, definition]) => ({
    key, definition, type: eventType(key, definition),
  }));
  const supported = normalized.filter((task) => selectQuestExecutor(task.type).supportsAutomaticProgress);
  const preferred = supported.find((task) => task.key === options.preferredProgressKey)
    ?? supported.find((task) => task.type === options.preferredEventName);
  if (preferred) return { task: preferred, entries: normalized };
  const progress = status?.progress;
  if (progress && typeof progress === 'object') {
    const matching = supported.find((task) => progress[task.key] != null || progress[task.type] != null);
    if (matching) return { task: matching, entries: normalized };
  }
  return {
    task: supported[0] ?? normalized[0] ?? {
      key: 'UNKNOWN_SCHEMA', type: 'UNKNOWN_SCHEMA', definition: { target: 0 },
    },
    entries: normalized,
  };
}

function rewardOrbs(config) {
  const candidates = [
    config.rewards_config?.rewards?.[0]?.quantity,
    config.rewards_config?.rewards?.[0]?.amount,
    config.reward?.orbs,
    config.orb_quantity,
  ];
  const value = candidates.map(Number).find((item) => Number.isInteger(item) && item >= 0);
  return value ?? null;
}

function artwork(config) {
  const value = config.assets?.hero
    ?? config.assets?.hero_image
    ?? config.application?.icon_url
    ?? config.messages?.game_tile;
  return typeof value === 'string' && value.startsWith('https://') ? value : null;
}

function questUrl(id, config) {
  const supplied = config.share_link ?? config.quest_url;
  if (typeof supplied === 'string') {
    try {
      const url = new URL(supplied);
      if (url.protocol === 'https:' && ['discord.com', 'www.discord.com'].includes(url.hostname)) {
        return url.toString();
      }
    } catch {
      // Use the deterministic Discord Quest URL below.
    }
  }
  return `https://discord.com/quests/${encodeURIComponent(id)}`;
}

export function normalizeQuest(raw, options = {}) {
  assertQuestObject(raw);
  const id = String(raw.id);
  const config = raw.config ?? {};
  const status = raw.user_status ?? {};
  const configuredTasks = taskEntries(config.task_config_v2 ?? config.task_config);
  const { task, entries } = chooseTask(configuredTasks, status, options);
  const target = finite(task.definition?.target);
  const issues = [];
  if (!entries.length) issues.push(questCompatibilityIssue('TASK_DEFINITIONS_MISSING', 'Task definitions are missing'));
  if (!(target > 0)) issues.push(questCompatibilityIssue('TASK_TARGET_INVALID', 'Task target is invalid'));
  if (((config.task_config_v2 ?? config.task_config)?.join_operator ?? 'or') === 'and' && entries.length > 1) {
    issues.push(questCompatibilityIssue('MULTI_TASK_AND', 'Multi-task AND is unsupported'));
  }
  const progressSecs = readProgress(status, task, target);
  const progress = target > 0 ? Math.min(100, (progressSecs / target) * 100) : 0;
  const executor = selectQuestExecutor({ eventName: task.type, autoSupported: issues.length === 0 });
  const startsAt = config.starts_at ?? null;
  const expiresAt = config.expires_at ?? null;
  return {
    id,
    name: config.messages?.quest_name ?? config.messages?.quest_title ?? id,
    applicationId: config.application?.id == null ? null : String(config.application.id),
    startsAt,
    expiresAt,
    eventName: task.type,
    progress,
    secondsNeeded: target,
    progressSecs,
    progressKey: task.key,
    autoSupported: issues.length === 0 && executor.supportsAutomaticProgress,
    executorId: executor.id,
    enrolledAt: status.enrolled_at ?? null,
    enrolled: Boolean(status.enrolled_at),
    completedAt: status.completed_at ?? null,
    completed: Boolean(status.completed_at),
    claimed: Boolean(status.claimed_at) || status.orb_quantity_claimed != null,
    orbs: rewardOrbs(config),
    artworkUrl: artwork(config),
    url: questUrl(id, config),
    schemaIssues: issues.map((issue) => issue.message),
    compatibilityIssues: issues,
    coreComplete: Boolean(id && task.type && target > 0 && startsAt && expiresAt && questUrl(id, config)),
  };
}

export function normalizeQuestPayload(payload, enrollmentBlockedUntil = null) {
  if (!Array.isArray(payload)) {
    throw new QuestCompatibilityError('Quest payload must be an array', {
      code: 'QUEST_PAYLOAD_NOT_ARRAY',
    });
  }
  return payload.map((quest) => ({ ...normalizeQuest(quest), enrollmentBlockedUntil }));
}
