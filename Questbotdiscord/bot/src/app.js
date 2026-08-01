import { randomUUID } from 'node:crypto';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { shutdownAppResources } from './app-resource-shutdown.js';
import { config } from './config.js';
import { startWorker, stopWorker } from './worker.js';
import { startDashboard, stopDashboard } from './dashboard.js';
import {
  refreshBuildInfo as logConfiguredClientProfile,
  restoreScheduledRunners,
  shutdownRunners,
} from './quest/runner-service.js';
import {
  installDiscordApiRuntime,
  uninstallDiscordApiRuntime,
} from './quest/discord-api-runtime.js';
import { closeDatabase } from './db.js';
import {
  acquireProcessRoleLease,
  processLeaseName,
  releaseProcessRoleLease,
  renewProcessRoleLease,
} from './process-topology.js';
import {
  redactSensitive,
  reportError,
  reportIncident,
} from './error-reporter.js';
import { INCIDENT } from './incident-catalog.js';
import { reportWithinFatalBudget } from './bootstrap.js';
import { installPersistentRunnerStatusHeaders } from './runner-status-header.js';

import * as ping from './commands/ping.js';
import * as help from './commands/help.js';
import * as apiStatus from './commands/api-status.js';
import * as run from './commands/run.js';
import * as stop from './commands/stop.js';
import * as panel from './commands/panel.js';

function isIgnorableInteractionError(error) {
  return error?.code === 10062 || error?.code === 40060;
}

function logDiscordError(label, error) {
  reportError(label, error, {
    context: {
      code: error?.code,
      status: error?.status,
      method: error?.method,
    },
  });
}

async function sendInteractionFailure(interaction) {
  const message = { content: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่', flags: 64 };
  if (interaction.replied || interaction.deferred) return interaction.followUp(message);
  return interaction.reply(message);
}

async function reportInteractionFailure(interaction, error) {
  if (isIgnorableInteractionError(error)) {
    console.warn(`⚠️ Ignored interaction error: ${error.code} ${redactSensitive(error.message)}`);
    return;
  }
  logDiscordError('Interaction error', error);
  try {
    await sendInteractionFailure(interaction);
  } catch (replyError) {
    if (!isIgnorableInteractionError(replyError)) {
      logDiscordError('Failed to report interaction error', replyError);
    }
  }
}

export function createApp({ exit = process.exit } = {}) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.commands = new Collection();
  installPersistentRunnerStatusHeaders(client);

  const commands = [ping, help, apiStatus, run, stop, panel];
  for (const command of commands) client.commands.set(command.data.name, command);

  const processRole = config.processRole === 'control' ? 'control' : 'all';
  const runtimeLeaseName = processLeaseName(processRole);
  const runtimeLeaseHolder = `${process.pid}:${randomUUID()}`;
  const seenInteractions = new Set();
  let runtimeLeaseTimer = null;
  let runtimeLeaseAcquired = false;
  let removeProcessHandlers = null;
  let shutdownPromise = null;
  let fatalShutdownPromise = null;
  let requestedExitCode = 0;

  function requestExitCode(exitCode) {
    requestedExitCode = Math.max(requestedExitCode, Number(exitCode) || 0);
  }

  function markInteractionSeen(id) {
    if (seenInteractions.has(id)) return false;
    seenInteractions.add(id);
    setTimeout(() => seenInteractions.delete(id), 60_000).unref?.();
    return true;
  }

  function routeModalSubmit(interaction) {
    if (interaction.customId.startsWith('run_modal:')) return run.handleModal(interaction);
    return undefined;
  }

  function routeButton(interaction) {
    if (interaction.customId.startsWith('panel:')) return panel.handleButton(interaction);
    if (interaction.customId.startsWith('runner-stop:')) return stop.handleButton(interaction);
    return undefined;
  }

  function routeStringSelect(interaction) {
    if (interaction.customId === 'runner-stop:select') return stop.handleSelect(interaction);
    return undefined;
  }

  function routeChatInput(interaction) {
    const command = client.commands.get(interaction.commandName);
    return command?.execute(interaction);
  }

  function routeInteraction(interaction) {
    if (interaction.isModalSubmit()) return routeModalSubmit(interaction);
    if (interaction.isButton()) return routeButton(interaction);
    if (interaction.isStringSelectMenu()) return routeStringSelect(interaction);
    if (interaction.isChatInputCommand()) return routeChatInput(interaction);
    return undefined;
  }

  async function handleInteraction(interaction) {
    if (!markInteractionSeen(interaction.id)) return;
    try {
      await routeInteraction(interaction);
    } catch (error) {
      await reportInteractionFailure(interaction, error);
    }
  }

  async function onClientReady() {
    console.log(`✅ บอทพร้อมแล้ว — logged in as ${client.user.tag} · role ${processRole}`);
    await startDashboard(client);
    startWorker();
    await restoreScheduledRunners(client);
  }

  function gracefulShutdown(reason, exitCode = 0) {
    requestExitCode(exitCode);
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      if (runtimeLeaseTimer) {
        clearInterval(runtimeLeaseTimer);
        runtimeLeaseTimer = null;
      }
      console.log(`🧹 Graceful shutdown — ${reason}`);

      try {
        await stopWorker(5000);
      } catch (error) {
        reportError('Runner worker shutdown', error);
        requestExitCode(1);
      }

      try {
        const stopped = await shutdownRunners();
        console.log(`🧹 Runner stopped cleanly: ${stopped}`);
      } catch (error) {
        reportError('Runner shutdown', error);
        requestExitCode(1);
      }

      const resources = await shutdownAppResources({
        destroyClient: () => client.destroy(),
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
        reportError('Database shutdown', error);
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
      const report = reportIncident({
        code,
        error,
        context: { ...context, processRole },
        scope: 'runtime',
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
      { component: 'runtime' },
    );
    const onUncaughtException = (error) => void fatalShutdown(
      INCIDENT.UNCAUGHT_EXCEPTION,
      error,
      { component: 'runtime' },
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
        new Error('Quest Bot process role conflicts with the active runtime topology'),
        { leaseName: runtimeLeaseName, holder: runtimeLeaseHolder },
      );
    }
    runtimeLeaseAcquired = true;
    runtimeLeaseTimer = setInterval(() => {
      if (!renewProcessRoleLease(processRole, runtimeLeaseHolder)) {
        void fatalShutdown(
          INCIDENT.RUNTIME_LEASE_LOST,
          new Error('Lost the Quest Bot process role lease'),
          { leaseName: runtimeLeaseName, holder: runtimeLeaseHolder },
        );
      }
    }, 30_000);
    runtimeLeaseTimer.unref?.();

    try {
      await startDashboard(null);
    } catch (error) {
      return fatalShutdown(
        INCIDENT.HEALTH_SERVER_BIND_FAILED,
        error,
        { port: config.port, errorCode: error?.code },
      );
    }

    try {
      await logConfiguredClientProfile();
    } catch (error) {
      return fatalShutdown(
        INCIDENT.CLIENT_STARTUP_FAILED,
        error,
        { stage: 'client-profile', component: 'discord-runner' },
      );
    }

    client.once('clientReady', () => {
      void onClientReady().catch((error) => fatalShutdown(
        INCIDENT.CLIENT_STARTUP_FAILED,
        error,
        { stage: 'client-ready', component: 'runner-restore' },
      ));
    });
    client.on('interactionCreate', handleInteraction);
    client.on('error', (error) => reportError('Discord client', error));
    client.on('shardError', (error, shardId) => reportError('Discord shard', error, {
      context: { shardId },
    }));
    client.on('warn', (message) => console.warn('⚠️ [Discord]', redactSensitive(message)));
    client.on('invalidated', () => {
      void fatalShutdown(
        INCIDENT.DISCORD_SESSION_INVALIDATED,
        new Error('Discord gateway session invalidated'),
      );
    });

    try {
      await client.login(config.token);
    } catch (error) {
      return fatalShutdown(
        INCIDENT.DISCORD_LOGIN_FAILED,
        error,
        { errorCode: error?.code, statusCode: error?.status },
      );
    }
    return client;
  }

  return {
    client,
    gracefulShutdown,
    installProcessHandlers,
    start,
  };
}
