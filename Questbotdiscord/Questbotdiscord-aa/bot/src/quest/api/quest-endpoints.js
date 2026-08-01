export const QUEST_LIST_PATHS = Object.freeze([
  '/quests/@me',
  '/users/@me/quests',
]);

export function encodeQuestId(questId) {
  const value = String(questId ?? '').trim();
  if (!value) throw new TypeError('Quest endpoint requires a non-empty quest id');
  return encodeURIComponent(value);
}

function questPath(questId, suffix) {
  return `/quests/${encodeQuestId(questId)}/${suffix}`;
}

const claimPath = (questId) => questPath(questId, 'claim');

export const QUEST_ENDPOINT = Object.freeze({
  me: () => '/users/@me',
  enroll: (questId) => questPath(questId, 'enroll'),
  videoProgress: (questId) => questPath(questId, 'video-progress'),
  heartbeat: (questId) => questPath(questId, 'heartbeat'),
  claimReward: (questId) => questPath(questId, 'claim-reward'),
  claim: claimPath,
  claimLegacy: claimPath,
});

export const FATAL_FORBIDDEN_PATHS = new Set([
  QUEST_ENDPOINT.me(),
  ...QUEST_LIST_PATHS,
]);
