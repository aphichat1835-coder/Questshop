import { setTimeout as delay } from 'node:timers/promises';

export async function runWorkerLoop({ name, signal, idleMs = 500, health, logger, runOnce,
  onIteration = async () => {} }) {
  health.workers[name] = { state: 'STARTING', lastTick: null, failures: 0 };
  while (!signal.aborted) {
    const started = performance.now();
    try {
      const worked = await runOnce();
      health.workers[name] = { ...health.workers[name], state: 'RUNNING', lastTick: new Date().toISOString() };
      if (worked) await onIteration({ name, worked, durationMs: Math.round(performance.now() - started) })
        .catch(() => {});
      if (!worked) await delay(idleMs, undefined, { signal, ref: false });
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') break;
      health.workers[name].failures += 1;
      health.workers[name].state = 'DEGRADED';
      logger.error({ error, worker: name }, 'worker iteration failed');
      await onIteration({ name, error, durationMs: Math.round(performance.now() - started) }).catch(() => {});
      await delay(Math.min(5_000, 250 * (2 ** Math.min(4, health.workers[name].failures))), undefined, { signal, ref: false }).catch(() => {});
    }
  }
  health.workers[name].state = 'STOPPED';
}
