import { closeHealthServer, createHealthState, startHealthServer } from './bootstrap/health-server.js';

let runtime;
let stopping;
let shutdownModule;
const health = createHealthState();
const requestedPort = /^\d+$/.test(process.env.PORT ?? '') ? Number(process.env.PORT) : 3000;
const port = requestedPort >= 1 && requestedPort <= 65535 ? requestedPort : 3000;
let server;
try {
  server = await startHealthServer({ port, statusToken: process.env.STATUS_TOKEN ?? 'unconfigured', state: health });
  const { startup } = await import('./bootstrap/startup.js');
  const stop = async (signal, options = {}) => {
    if (!runtime) return;
    if (options.leaseLost) process.exitCode = 1;
    stopping ??= (async () => {
      shutdownModule ??= await import('./bootstrap/shutdown.js');
      await shutdownModule.shutdown(runtime, signal, options);
    })().catch(() => { process.exitCode = 1; });
    await stopping;
  };
  runtime = await startup({ health, server,
    onRuntimeLeaseLost: (error) => stop('RUNTIME_LEASE_LOST', { leaseLost: true, error }) });
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
} catch (error) {
  health.status = 'NOT_READY';
  health.lastError = error;
  health.live = false;
  await closeHealthServer(server).catch(() => null);
  process.exitCode = 1;
}
