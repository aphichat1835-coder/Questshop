import { closeHealthServer, createHealthState, startHealthServer } from './bootstrap/health-server.js';

let runtime;
const health = createHealthState();
const requestedPort = /^\d+$/.test(process.env.PORT ?? '') ? Number(process.env.PORT) : 3000;
const port = requestedPort >= 1 && requestedPort <= 65535 ? requestedPort : 3000;
let server;
try {
  server = await startHealthServer({ port, statusToken: process.env.STATUS_TOKEN ?? 'unconfigured', state: health });
  const { startup } = await import('./bootstrap/startup.js');
  runtime = await startup({ health, server });
} catch (error) {
  health.status = 'NOT_READY';
  health.lastError = error;
  health.live = false;
  await closeHealthServer(server).catch(() => null);
  process.exitCode = 1;
}
if (runtime) {
  const { shutdown } = await import('./bootstrap/shutdown.js');
  let stopping;
  const stop = async (signal) => {
    stopping ??= shutdown(runtime, signal).catch(() => { process.exitCode = 1; });
    await stopping;
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}
