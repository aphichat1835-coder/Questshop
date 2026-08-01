import { assertQuestExecutorContract } from './contract.js';
import { desktopQuestExecutor } from './desktop-executor.js';
import { unknownQuestExecutor, unsupportedQuestExecutor } from './unsupported-executor.js';
import { videoQuestExecutor } from './video-executor.js';

const automaticExecutors = Object.freeze([
  videoQuestExecutor,
  desktopQuestExecutor,
]);

export const QUEST_EXECUTORS = Object.freeze([
  ...automaticExecutors,
  unsupportedQuestExecutor,
]);

for (const executor of [...QUEST_EXECUTORS, unknownQuestExecutor]) {
  assertQuestExecutorContract(executor);
}

export function selectQuestExecutor(value) {
  const quest = typeof value === 'string' ? { eventName: value } : value;
  if (quest?.autoSupported === false) return unsupportedQuestExecutor;
  return QUEST_EXECUTORS.find((executor) => executor.matches(quest)) ?? unknownQuestExecutor;
}

export function isAutomaticallySupportedEvent(eventName) {
  return selectQuestExecutor(eventName).supportsAutomaticProgress;
}

export function describeUnsupportedQuest(quest) {
  const executor = selectQuestExecutor(quest);
  return executor.supportsAutomaticProgress ? null : executor.describeUnsupportedReason(quest);
}

export function listQuestExecutorCapabilities() {
  return QUEST_EXECUTORS.map(({ id, supportsAutomaticProgress, mutation }) => ({
    id,
    supportsAutomaticProgress,
    mutation,
  }));
}
