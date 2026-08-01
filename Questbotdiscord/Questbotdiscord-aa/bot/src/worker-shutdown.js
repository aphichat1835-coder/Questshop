async function runCleanupStep(label, operation, reportError) {
  try {
    await operation();
    return null;
  } catch (error) {
    try {
      reportError(label, error);
    } catch {
      // Cleanup must continue even when the reporter itself is unavailable.
    }
    return { label, error };
  }
}

export async function shutdownWorkerResources({
  stopSupervisor,
  shutdownRunners,
  releaseClaims,
  stopDashboard,
  uninstallRuntime,
  reportError,
} = {}) {
  const steps = [
    ['Scheduled worker supervisor shutdown', stopSupervisor],
    ['Scheduled runner shutdown', shutdownRunners],
    ['Scheduled worker claim release', releaseClaims],
    ['Worker dashboard shutdown', stopDashboard],
    ['Discord API runtime uninstall', uninstallRuntime],
  ];
  const failures = [];

  for (const [label, operation] of steps) {
    if (typeof operation !== 'function') {
      const error = new TypeError(`${label} operation is required`);
      try {
        reportError?.(label, error);
      } catch {}
      failures.push({ label, error });
      continue;
    }
    const failure = await runCleanupStep(label, operation, reportError ?? (() => {}));
    if (failure) failures.push(failure);
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}
