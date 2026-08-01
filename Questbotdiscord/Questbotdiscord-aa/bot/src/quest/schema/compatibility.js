export class QuestCompatibilityError extends Error {
  constructor(message, { code = 'QUEST_SCHEMA_INCOMPATIBLE', details = null } = {}) {
    super(message);
    this.name = 'QuestCompatibilityError';
    this.code = code;
    this.details = details;
  }
}

export function questCompatibilityIssue(code, message, details = null) {
  return Object.freeze({ code, message, details });
}

export function assertQuestObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.id) {
    throw new QuestCompatibilityError('Quest item is missing a valid id', {
      code: 'QUEST_ID_MISSING',
    });
  }
  return raw;
}

export function extractQuestArray(candidate, path = 'Quest API') {
  if (Array.isArray(candidate)) return candidate;
  if (candidate && typeof candidate === 'object' && Array.isArray(candidate.quests)) {
    return candidate.quests;
  }
  throw new QuestCompatibilityError(
    `Quest API schema changed at ${path}: expected an array or { quests: [] }`,
    { code: 'QUEST_LIST_SHAPE_CHANGED' },
  );
}

export function summarizeQuestCompatibility(quests, selectExecutor) {
  const unknownEvents = [];
  const schemaIssues = [];
  for (const quest of quests ?? []) {
    const executor = selectExecutor(quest);
    if (executor?.id === 'unknown') unknownEvents.push(quest.eventName);
    for (const issue of quest.schemaIssues ?? []) schemaIssues.push(issue);
  }
  return {
    unknownEvents: [...new Set(unknownEvents.filter(Boolean))],
    schemaIssues: [...new Set(schemaIssues.filter(Boolean))],
  };
}
