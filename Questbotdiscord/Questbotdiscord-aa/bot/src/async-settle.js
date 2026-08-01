function timeoutError(timeoutMessage, pendingCount) {
  const message = typeof timeoutMessage === 'function'
    ? timeoutMessage(pendingCount)
    : timeoutMessage;
  return new Error(message || `Timed out with ${pendingCount} task(s) pending`);
}

export async function settleWithTimeout(tasks, timeoutMs = null, {
  pendingCount = () => 0,
  timeoutMessage = null,
} = {}) {
  const pending = Promise.allSettled(tasks);
  if (timeoutMs == null) return pending;

  const timeoutResult = Symbol('timeout');
  let timeout;
  try {
    const result = await Promise.race([
      pending,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(timeoutResult), Math.max(0, timeoutMs));
      }),
    ]);
    if (result !== timeoutResult) return result;

    const remaining = Math.max(0, Number(pendingCount()) || 0);
    if (remaining > 0) throw timeoutError(timeoutMessage, remaining);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
