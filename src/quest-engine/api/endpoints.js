export const QUEST_LIST_PATHS = Object.freeze(['/quests/@me', '/users/@me/quests']);
const FIXED_QUEST_API_PATHS = new Set(['/users/@me', ...QUEST_LIST_PATHS]);
const QUEST_ACTION_PATH = /^\/quests\/[A-Za-z0-9_-]+\/(?:enroll|video-progress|heartbeat)$/;

// These are the only endpoints where a 403 proves that the credential itself
// is unusable. A 403 from an individual Quest action can be a Quest-specific
// restriction and must not quarantine a Monitor account.
export const FATAL_FORBIDDEN_PATHS = new Set(['/users/@me', ...QUEST_LIST_PATHS]);

function questPath(questId, suffix) {
  const id = String(questId ?? '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new TypeError('Quest id is invalid');
  return `/quests/${id}/${suffix}`;
}

// The Quest adapter never accepts a host, query string, or arbitrary Discord
// route from a caller.  Keeping this allowlist next to endpoint construction
// makes the fixed-host request boundary independently auditable.
export function isAllowedQuestApiPath(path) {
  return FIXED_QUEST_API_PATHS.has(path) || QUEST_ACTION_PATH.test(path);
}

export const QUEST_ENDPOINT = Object.freeze({
  me: () => '/users/@me',
  enroll: (id) => questPath(id, 'enroll'),
  videoProgress: (id) => questPath(id, 'video-progress'),
  heartbeat: (id) => questPath(id, 'heartbeat'),
});
