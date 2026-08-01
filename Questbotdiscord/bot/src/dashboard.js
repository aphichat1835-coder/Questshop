import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { config } from './config.js';
import {
  getQuestEngineStatus,
  listJobs,
  listQuestEngineStatuses,
} from './discord-runner.js';
import { listActiveProcessRoles } from './process-topology.js';
import { listScheduledRunners } from './scheduled-runner-store.js';
import {
  getIncidentReporterStatus,
  reportError,
} from './error-reporter.js';
import { getBackupHealthStatus } from './worker.js';

const PORT = config.port;
let botClient = null;
let server = null;
let startPromise = null;
const startedAt = Date.now();

export function startDashboard(client) {
  if (client) botClient = client;
  if (server?.listening) return Promise.resolve(server);
  if (startPromise) return startPromise;

  server = createServer(handleRequest);
  startPromise = new Promise((resolve, reject) => {
    const startingServer = server;
    const onStartupError = (error) => {
      startingServer.off('listening', onListening);
      if (server === startingServer) server = null;
      startPromise = null;
      reject(error);
    };
    const onListening = () => {
      startingServer.off('error', onStartupError);
      startingServer.on('error', (error) => reportError('Health server runtime', error, {
        context: { port: PORT, errorCode: error?.code },
      }));
      console.log(`🌐 Health server ready → port ${PORT}`);
      startPromise = null;
      resolve(startingServer);
    };

    startingServer.once('error', onStartupError);
    startingServer.once('listening', onListening);
    startingServer.listen(PORT);
  });
  return startPromise;
}

export async function stopDashboard() {
  const activeServer = server;
  const pendingStart = startPromise;
  server = null;
  startPromise = null;
  if (!activeServer) return;

  if (!activeServer.listening && pendingStart) {
    try {
      await pendingStart;
    } catch {
      return;
    }
  }
  if (!activeServer.listening) return;

  await new Promise((resolve, reject) => activeServer.close((error) => {
    if (error) reject(error);
    else resolve();
  }));
}

function statusSnapshot(status) {
  return {
    key: status.key,
    ownerId: status.ownerId,
    accountId: status.accountId,
    username: status.username,
    jobKey: status.jobKey,
    mode: status.mode,
    lifecycle: status.lifecycle,
    state: status.state,
    questCount: status.questCount,
    supportedCount: status.supportedCount,
    excludedCount: status.excludedCount,
    lastCheckAt: status.lastCheckAt,
    lastSuccessfulCheckAt: status.lastSuccessfulCheckAt,
    lastVerifiedProgressAt: status.lastVerifiedProgressAt,
    lastVerifiedCompletionAt: status.lastVerifiedCompletionAt,
    lastVerifiedClaimAt: status.lastVerifiedClaimAt,
    questListPath: status.questListPath,
    unknownEvents: status.unknownEvents,
    schemaIssues: status.schemaIssues,
    lastError: status.lastError,
  };
}

function storageStatus() {
  return {
    mode: config.storageProfile.mode,
    databasePathType: config.storageProfile.databasePathType,
    durability: config.storageProfile.durability,
    durabilityVerified: config.storageProfile.durabilityVerified,
    warning: config.storageProfile.warning,
  };
}

export function detailedStatusPayload() {
  const jobs = listJobs();
  const quest = getQuestEngineStatus();
  const accountStatuses = listQuestEngineStatuses().map(statusSnapshot);
  return {
    ok: botClient?.isReady() ?? false,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    pingMs: botClient?.ws?.ping ?? -1,
    runtime: {
      role: config.processRole,
      activeRoles: listActiveProcessRoles(),
      workerPollIntervalMs: config.workerPollIntervalMs,
    },
    logging: getIncidentReporterStatus(),
    storage: storageStatus(),
    backup: getBackupHealthStatus(),
    runners: {
      active: jobs.length,
      oneShot: jobs.filter((job) => job.mode === 'oneshot').length,
      autoDaily: jobs.filter((job) => job.mode === 'scheduled').length,
      persisted: listScheduledRunners().length,
    },
    questApi: {
      aggregate: statusSnapshot(quest),
      accounts: accountStatuses,
    },
  };
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

export function hasStatusAccess(authorization, expected = config.healthStatusToken) {
  if (!expected || typeof authorization !== 'string') return false;
  if (!authorization.startsWith('Bearer ')) return false;
  const supplied = authorization.slice(7);
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function handleRequest(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/healthz') {
    const ok = botClient?.isReady() ?? false;
    return sendJson(res, ok ? 200 : 503, { ok });
  }

  if (pathname === '/api/status') {
    if (!config.healthStatusToken) return sendJson(res, 404, { error: 'not_found' });
    if (!hasStatusAccess(req.headers.authorization)) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    const payload = detailedStatusPayload();
    return sendJson(res, payload.ok ? 200 : 503, payload);
  }

  return sendJson(res, 404, { error: 'not_found' });
}
