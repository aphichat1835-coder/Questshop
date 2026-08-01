const REQUIRED_METHODS = Object.freeze([
  'matches',
  'validate',
  'estimateDuration',
  'execute',
  'verify',
  'describeUnsupportedReason',
]);

function requiredFunction(executor, method) {
  if (typeof executor?.[method] !== 'function') {
    throw new TypeError(`Quest executor ${executor?.id ?? '<unknown>'} is missing ${method}()`);
  }
}

export function assertQuestExecutorContract(executor) {
  if (!executor || typeof executor !== 'object') {
    throw new TypeError('Quest executor must be an object');
  }
  if (typeof executor.id !== 'string' || executor.id.trim() === '') {
    throw new TypeError('Quest executor id must be a non-empty string');
  }
  for (const method of REQUIRED_METHODS) requiredFunction(executor, method);
  if (typeof executor.supportsAutomaticProgress !== 'boolean') {
    throw new TypeError(`Quest executor ${executor.id} must declare supportsAutomaticProgress`);
  }
  if (executor.mutation != null && typeof executor.mutation !== 'string') {
    throw new TypeError(`Quest executor ${executor.id} mutation must be a string or null`);
  }
  return executor;
}

export function defineQuestExecutor(definition) {
  return Object.freeze(assertQuestExecutorContract({ ...definition }));
}

export function normalizeExecutorValidation(result) {
  if (result === true || result == null) return { ok: true, issues: [] };
  if (result === false) return { ok: false, issues: ['executor validation failed'] };
  if (typeof result === 'string') return { ok: false, issues: [result] };
  if (typeof result !== 'object') {
    throw new TypeError('Executor validate() must return boolean, string, object, or null');
  }
  return {
    ok: result.ok !== false,
    issues: Array.isArray(result.issues) ? result.issues.map(String) : [],
  };
}

export async function executeQuestExecutor(executor, context) {
  assertQuestExecutorContract(executor);
  const validation = normalizeExecutorValidation(await executor.validate(context?.quest, context));
  if (!validation.ok) {
    const error = new Error(validation.issues.join('; ') || `Quest executor ${executor.id} rejected the Quest`);
    error.name = 'QuestExecutorValidationError';
    error.executorId = executor.id;
    error.issues = validation.issues;
    throw error;
  }
  const executionResult = await executor.execute(context);
  const verified = await executor.verify(context, executionResult);
  return { executionResult, verified: Boolean(verified) };
}
