async function runResourceStep(label, operation, reportError) {
  try {
    await operation();
    return null;
  } catch (error) {
    try {
      reportError(label, error);
    } catch {
      // Resource cleanup must continue even if reporting is unavailable.
    }
    return { label, error };
  }
}

export async function shutdownAppResources({
  destroyClient,
  stopDashboard,
  uninstallRuntime,
  reportError,
} = {}) {
  const steps = [
    ['Discord client shutdown', destroyClient],
    ['Dashboard shutdown', stopDashboard],
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
    const failure = await runResourceStep(label, operation, reportError ?? (() => {}));
    if (failure) failures.push(failure);
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}
