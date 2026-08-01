import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { startDashboard, stopDashboard } from './dashboard.js';
import { closeDatabase } from './db.js';
import { reportError, reportIncident } from './error-reporter.js';
import { INCIDENT } from './incident-catalog.js';
import { reportWithinFatalBudget } from './bootstrap.js';
import {
  acquireProcessRoleLease,
  processLeaseName,
  releaseProcessRoleLease,
  renewProcessRoleLease,
} from './process-topology.js';
import {
  installDiscordApiRuntime,
  uninstallDiscordApiRuntime,
} from './quest/discord-api-runtime.js';
import { shutdownRunners } from './quest/runner-service.js';
import {
  releaseScheduledWorkerSupervisorClaims,
  startScheduledWorkerSupervisor,
  stopScheduledWorkerSupervisor,
} from './quest/scheduled-worker-supervisor.js';
import { createWorkerDiscordClient } from './quest/worker-discord-client.js';
import { shutdownWorkerResources } from './worker-shutdown.js';

export function createWorkerApp({ exit = process.exit } = {}) {
  const processRole = 'worker';
  const runtimeLeaseHolder = `${process.pid}:${randomUUID()}`;
  const runtimeLeaseName = processLeaseName(processRole, runtimeLeaseHolder);
  const outputClient = createWorkerDiscordClient();
  let runtimeLeaseTimer = null;
  let runtimeLeaseAcquired = false;
  let removeProcessHandlers = null;
  let shutdownPromise = null;
  let fatalShutdownPromise = null;
  let requestedExitCode = 0;

  function requestExitCode(exitCode) {
    requestedExitCode = Math.max(requestedExitCode, Number(exitCode) || 0);
  }

  function gracefulShutdown(reason, exitCode = 0) {
    requestExitCode(exitCode);
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      outputClient.markNotReady();
      if (runtimeLeaseTimer) {
        clearInterval(runtimeLeaseTimer);
        runtimeLeaseTimer = null;
      }
      console.log(`🧹 Scheduled worker shutdown — ${reason}`);

      const resources = await shutdownWorkerResources({
        stopSupervisor: () => stopScheduledWorkerSupervisor({ releaseClaims: false }),
        shutdownRunners,
        releaseClaims: releaseScheduledWorkerSupervisorClaims,
        stopDashboard,
        uninstallRuntime: uninstallDiscordApiRuntime,
        reportError,
      });
      if (!resources.ok) requestExitCode(1);

      try {
        if (runtimeLeaseAcquired) {
          releaseProcessRoleLease(processRole, runtimeLeaseHolder);
          runtimeLeaseAcquired = false;
        }
        closeDatabase();
      } catch (error) {
        reportError('Scheduled worker database shutdown', error);
        requestExitCode(1);
      }

      removeProcessHandlers?.();
      removeProcessHandlers = null;
      exit(requestedExitCode);
      return requestedExitCode;
    })();

    return shutdownPromise;
  }

  function fatalShutdown(code, error, context = {}) {
    requestExitCode(1);
    if (fatalShutdownPromise) return fatalShutdownPromise;

    fatalShutdownPromise = (async () => {
      outputClient.markNotReady();
      const report = reportIncident({
        code,
        error,
        context: { ...context, processRole },
        scope: 'worker',
        source: code,
      }).catch(() => ({ state: 'report_failed' }));
      await reportWithinFatalBudget(report);
      return gracefulShutdown(code, 1);
    })();
    return fatalShutdownPromise;
  }

  function installProcessHandlers() {
    if (removeProcessHandlers) return removeProcessHandlers;
    const onSigterm = () => void gracefulShutdown('SIGTERM');
    const onSigint = () => void gracefulShutdown('SIGINT');
    const onUnhandledRejection = (reason) => void fatalShutdown(
      INCIDENT.UNHANDLED_REJECTION,
      reason,
      { component: 'scheduled-worker' },
    );
    const onUncaughtException = (error) => void fatalShutdown(
      INCIDENT.UNCAUGHT_EXCEPTION,
      error,
      { component: 'scheduled-worker' },
    );

    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);
    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);
    removeProcessHandlers = () => {
      process.off('SIGTERM', onSigterm);
      process.off('SIGINT', onSigint);
      process.off('unhandledRejection', onUnhandledRejection);
      process.off('uncaughtException', onUncaughtException);
    };
    return removeProcessHandlers;
  }

  async function start() {
    installDiscordApiRuntime();
    if (!acquireProcessRoleLease(processRole, runtimeLeaseHolder)) {
      return fatalShutdown(
        INCIDENT.RUNTIME_LEASE_CONFLICT,
        new Error('Scheduled worker conflicts with an all-in-one process'),
        { leaseName: runtimeLeaseName, holder: runtimeLeaseHolder },
      );
    }
    runtimeLeaseAcquired = true;
    runtimeLeaseTimer = setInterval(() => {
      if (!renewProcessRoleLease(processRole, runtimeLeaseHolder)) {
        void fatalShutdown(
          INCIDENT.RUNTIME_LEASE_LOST,
          new Error('Scheduled worker lost its runtime lease'),
          { leaseName: runtimeLeaseName, holder: runtimeLeaseHolder },
        );
      }
    }, 30_000);
    runtimeLeaseTimer.unref?.();

    try {
      await startDashboard(outputClient);
      await startScheduledWorkerSupervisor(outputClient, {
        holder: runtimeLeaseHolder,
      });
      outputClient.markReady();
      console.log(
        `✅ Scheduled worker ready · poll ${config.workerPollIntervalMs}ms · API v10`,
      );
    } catch (error) {
      outputClient.markNotReady();
      return fatalShutdown(
        error?.incidentCode || INCIDENT.CLIENT_STARTUP_FAILED,
        error,
        { stage: 'worker-startup', component: 'scheduled-worker' },
      );
    }
    return outputClient;
  }

  return {
    installProcessHandlers,
    gracefulShutdown,
    start,
  };
}
