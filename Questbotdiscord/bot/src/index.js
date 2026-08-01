import {
  fatalBootstrapShutdown,
  installBootstrapProcessHandlers,
} from './bootstrap.js';
import { INCIDENT } from './incident-catalog.js';

const removeBootstrapHandlers = installBootstrapProcessHandlers();

try {
  const { config } = await import('./config.js');
  const applicationModule = config.processRole === 'worker'
    ? './worker-app.js'
    : './app.js';
  const applicationExport = config.processRole === 'worker'
    ? 'createWorkerApp'
    : 'createApp';
  const application = await import(applicationModule);
  const app = application[applicationExport]();
  app.installProcessHandlers();
  removeBootstrapHandlers();
  await app.start();
} catch (error) {
  removeBootstrapHandlers();
  await fatalBootstrapShutdown({
    code: error?.incidentCode || INCIDENT.CLIENT_STARTUP_FAILED,
    error,
    context: error?.bootstrapContext || {
      stage: 'module-import',
      component: 'application',
    },
  });
  process.exit(1);
}
