const REQUIRED_METHODS = Object.freeze([
  'matches', 'validate', 'estimateDuration', 'execute', 'verify', 'describeUnsupportedReason',
]);

export function assertQuestExecutorContract(executor) {
  if (!executor || typeof executor !== 'object' || !executor.id?.trim()) {
    throw new TypeError('Quest executor must have a non-empty id');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof executor[method] !== 'function') {
      throw new TypeError(`Quest executor ${executor.id} is missing ${method}()`);
    }
  }
  if (typeof executor.supportsAutomaticProgress !== 'boolean') {
    throw new TypeError(`Quest executor ${executor.id} must declare supportsAutomaticProgress`);
  }
  return executor;
}

export function defineQuestExecutor(definition) {
  return Object.freeze(assertQuestExecutorContract({ ...definition }));
}

export async function executeQuestExecutor(executor, context) {
  assertQuestExecutorContract(executor);
  const validation = await executor.validate(context.quest, context);
  const normalized = validation === true || validation == null
    ? { ok: true, issues: [] }
    : typeof validation === 'object'
      ? { ok: validation.ok !== false, issues: validation.issues ?? [] }
      : { ok: false, issues: [String(validation)] };
  if (!normalized.ok) {
    const error = new Error(normalized.issues.join('; ') || 'executor validation failed');
    error.name = 'QuestExecutorValidationError';
    error.executorId = executor.id;
    throw error;
  }
  const executionResult = await executor.execute(context);
  return { executionResult, verified: Boolean(await executor.verify(context, executionResult)) };
}

