export const QUEST_LIST_PATHS = Object.freeze(['/quests/@me', '/users/@me/quests']);

function questPath(questId, suffix) {
  const id = String(questId ?? '').trim();
  if (!id) throw new TypeError('Quest id is required');
  return `/quests/${encodeURIComponent(id)}/${suffix}`;
}

export const QUEST_ENDPOINT = Object.freeze({
  me: () => '/users/@me',
  enroll: (id) => questPath(id, 'enroll'),
  videoProgress: (id) => questPath(id, 'video-progress'),
  heartbeat: (id) => questPath(id, 'heartbeat'),
});

