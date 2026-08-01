import { defineQuestExecutor } from './contract.js';

export const UNSUPPORTED_EVENTS = new Set([
  'STREAM_ON_DESKTOP',
  'ACHIEVEMENT_IN_GAME',
  'ACHIEVEMENT_IN_ACTIVITY',
  'PLAY_ACTIVITY',
  'PLAY_ON_XBOX',
  'PLAY_ON_PLAYSTATION',
  'progress',
]);

function reasonForQuest(quest) {
  if (!quest?.eventName) return 'UNKNOWN_SCHEMA';
  if (UNSUPPORTED_EVENTS.has(quest.eventName)) return 'UNSUPPORTED_EVENT';
  const recordedIssue = quest?.compatibilityIssues?.[0]?.code;
  if (recordedIssue) return recordedIssue;
  if (quest?.autoSupported === false) return 'MULTI_TASK_AND';
  return 'UNKNOWN_EVENT';
}

export const unsupportedQuestExecutor = defineQuestExecutor({
  id: 'unsupported',
  supportsAutomaticProgress: false,
  mutation: null,
  matches(value) {
    const eventName = typeof value === 'string' ? value : value?.eventName;
    return UNSUPPORTED_EVENTS.has(eventName) || value?.autoSupported === false;
  },
  validate(quest) {
    return { ok: false, issues: [reasonForQuest(quest)] };
  },
  estimateDuration() {
    return null;
  },
  execute() {
    throw new Error('Unsupported Quest executor cannot execute progress');
  },
  verify() {
    return false;
  },
  describeUnsupportedReason: reasonForQuest,
});

export const unknownQuestExecutor = defineQuestExecutor({
  id: 'unknown',
  supportsAutomaticProgress: false,
  mutation: null,
  matches() {
    return false;
  },
  validate() {
    return { ok: false, issues: ['UNKNOWN_EVENT'] };
  },
  estimateDuration() {
    return null;
  },
  execute() {
    throw new Error('Unknown Quest executor cannot execute progress');
  },
  verify() {
    return false;
  },
  describeUnsupportedReason() {
    return 'UNKNOWN_EVENT';
  },
});
