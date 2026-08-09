export const QUEST_LIST_PATHS = Object.freeze(['/quests/@me', '/users/@me/quests']);

// These are the only endpoints where a 403 proves that the credential itself
// is unusable. A 403 from an individual Quest action can be a Quest-specific
// restriction and must not quarantine a Monitor account.
export const FATAL_FORBIDDEN_PATHS = new Set(['/users/@me', ...QUEST_LIST_PATHS]);

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
