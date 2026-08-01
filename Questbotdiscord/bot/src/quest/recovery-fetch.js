function isAbortError(error) {
  return error?.name === 'AbortError' || error?.message === 'aborted';
}

export async function fetchDurableRecoveryQuests({
  fetchQuests,
  userToken,
  signal,
  isFatalAuthError,
  onDeferred = async () => {},
}) {
  if (typeof fetchQuests !== 'function') throw new TypeError('fetchQuests callback is required');
  if (typeof isFatalAuthError !== 'function') {
    throw new TypeError('isFatalAuthError callback is required');
  }

  try {
    return await fetchQuests(userToken, signal);
  } catch (error) {
    if (isAbortError(error) || isFatalAuthError(error)) throw error;
    await onDeferred(error);
    return null;
  }
}
