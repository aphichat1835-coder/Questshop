import { startup } from './bootstrap/startup.js';
import { shutdown } from './bootstrap/shutdown.js';

let runtime;
try {
  runtime = await startup();
} catch {
  process.exitCode = 1;
}
if (runtime) {
  let stopping;
  const stop = async (signal) => {
    stopping ??= shutdown(runtime, signal).catch(() => { process.exitCode = 1; });
    await stopping;
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}
