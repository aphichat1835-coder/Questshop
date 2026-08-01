import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';
import {
  addScheduleJitter,
  nextRecheckState,
  nextScheduledCheck,
  RECHECK_INTERVAL_MS,
  transientRetryDelayMs,
} from './runner-schedule.js';
import { executeVerifiedMutation } from './mutation-retry.js';
import { settleWithTimeout } from './async-settle.js';
import {
  clearQuestStatuses as clearStoredQuestStatuses,
  getQuestStatus as getStoredQuestStatus,
  listQuestStatuses as listStoredQuestStatuses,
  recordQuestAttempt,
  recordQuestFailure,
  recordQuestSuccess,
  recordQuestVerification,
  setQuestStatusLifecycle,
} from './quest-status-store.js';
import { reportCriticalError } from './error-reporter.js';
import {
  decryptRunnerToken,
  deleteScheduledRunner,
  listScheduledRunners,
  updateScheduledRunner,
} from './scheduled-runner-store.js';
import {
  completeOneShotQuest,
  createOneShotQuestSession,
  failOneShotQuest,
  getNextPendingOneShotQuest,
  getOneShotSessionSummary,
  isOneShotSessionComplete,
  markOneShotProgressMutationSent,
  markOneShotQuestRunning,
  recordOneShotRewardClaim,
  recordOneShotVerifiedProgress,
} from './one-shot-quest-session.js';
import {
  claimQuestRequest,
  currentDiscordClientProfile,
  enrollQuestRequest,
  fetchCurrentUser,
  fetchQuestPayload,
  isFatalAuthError,
  sendHeartbeatRequest,
  sendVideoProgressRequest,
} from './quest/api/discord-client.js';
import { questActionFailureReason } from './quest/action-error-summary.js';
import {
  claimRetryAt as durableClaimRetryAt,
  CLAIM_RETRY_DELAY_MS,
  CLAIM_RETRY_REASON,
  classifyClaimRetry,
  persistClaimRetry,
} from './quest/claim-retry-policy.js';
import {
  normalizeQuest as normalizeQuestV2,
  normalizeQuestPayload as normalizeQuestPayloadV2,
} from './quest/schema/normalizer.js';
import { QuestCompatibilityError } from './quest/schema/compatibility.js';
import {
  executeQuestExecutor,
  selectQuestExecutor,
} from './quest/executors.js';
import { currentRunnerExecutionContext } from './quest/runner-execution-context.js';
import { assertRunnerMutationOwnership } from './quest/runner-ownership-guard.js';
import { verifyRunnerMutationFromQuests } from './quest/durable-mutation-verifier.js';
import { fetchDurableRecoveryQuests } from './quest/recovery-fetch.js';
import {
  getRunnerState,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
  transitionRunnerState,
} from './quest/runner-state-store.js';

export { DiscordApiError } from './quest/api/discord-client.js';
export { isFatalAuthError };

const TERMINAL_RUNNER_ERROR_CODES = new Set([
  'RUNNER_CHECKPOINT_FAILED',
  'RUNNER_MUTATION_CHECKPOINT_FAILED',
  'RUNNER_MUTATION_REQUIRES_VERIFICATION',
  'RUNNER_OWNERSHIP_LOST',
]);

function isTerminalRunnerError(error) {
  return TERMINAL_RUNNER_ERROR_CODES.has(error?.code);
}

/**
 * Keep one coherent client profile for the whole process. Override all related
 * values together through Environment Variables after verifying a Discord update.
 */
export async function refreshBuildInfo() {
  const profile = currentDiscordClientProfile();
  console.log(
    `🔄 Client profile — Client: ${profile.clientVersion} | Build: ${profile.buildNumber} | Chrome: ${profile.chromeVersion} | Electron: ${profile.electronVersion}`,
  );
  return profile;
}

// Quest execution support is defined by the plugin registry only.
function questExecutor(value) {
  return selectQuestExecutor(typeof value === 'string' ? { eventName: value } : value);
}

function isSupportedEvent(value) {
  return questExecutor(value).supportsAutomaticProgress;
}

function questUnavailableReason(quest, now = Date.now()) {
  if (quest.autoSupported === false) return 'ต้องทำหลาย task พร้อมกัน';
  const enrollmentBlockedUntil = Date.parse(quest.enrollmentBlockedUntil);
  if (!quest.enrolled && Number.isFinite(enrollmentBlockedUntil) && enrollmentBlockedUntil > now) {
    return 'Discord ยังไม่เปิดให้รับ Quest';
  }
  const startsAt = Date.parse(quest.startsAt);
  if (Number.isFinite(startsAt) && startsAt > now) return 'ยังไม่เริ่ม';
  const expiresAt = Date.parse(quest.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= now) return 'หมดเวลาแล้ว';
  return null;
}

function isRunnableQuest(quest) {
  return isSupportedEvent(quest) && !questUnavailableReason(quest);
}

function oneShotFreshQuestFailureReason(error) {
  if (error instanceof QuestCompatibilityError && /disappeared from Quest API/.test(error.message)) {
    return 'ไม่พบ Quest ในรายการล่าสุดจาก Discord';
  }
  return questActionFailureReason(error, 'ตรวจสอบสถานะ Quest ล่าสุด');
}

function oneShotUnavailableReason(quest) {
  const reason = questUnavailableReason(quest);
  if (reason === 'หมดเวลาแล้ว') return 'Quest หมดเวลาก่อนดำเนินการเสร็จ';
  if (reason === 'Discord ยังไม่เปิดให้รับ Quest') {
    return 'Discord ยังไม่เปิดให้ดำเนินการ Quest';
  }
  return reason || 'Quest ไม่พร้อมให้ดำเนินการ';
}

export function selectQuestClaimPlatform(quest) {
  const platforms = Array.isArray(quest?.rewardPlatforms)
    ? quest.rewardPlatforms.filter(Number.isInteger)
    : [];
  if (platforms.length === 0) return 0;
  if (platforms.includes(4)) return 4;
  if (platforms.includes(0)) return 0;
  if (platforms.length === 1) return platforms[0];
  return null;
}

function isAbortFailure(error, signal) {
  return signal?.aborted
    || error?.name === 'AbortError'
    || error?.message === 'aborted';
}

function abortFailure() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

const questStatusStorage = new AsyncLocalStorage();

function normalizeStatusContext(context = {}) {
  if (typeof context === 'string') return { key: context };
  return {
    key: context.key || context.jobKey || 'system',
    ownerId: context.ownerId ?? null,
    accountId: context.accountId ?? null,
    username: context.username ?? null,
    jobKey: context.jobKey ?? null,
    mode: context.mode ?? null,
    lifecycle: context.lifecycle ?? 'running',
  };
}

function currentQuestStatusContext() {
  return questStatusStorage.getStore() ?? normalizeStatusContext();
}

const ACTIVE_MUTATION_STATUSES = new Set([
  RUNNER_MUTATION_STATUS.PREPARED,
  RUNNER_MUTATION_STATUS.IN_FLIGHT,
  RUNNER_MUTATION_STATUS.ACCEPTED,
  RUNNER_MUTATION_STATUS.UNCERTAIN,
]);

function transitionCurrentRunner(state, values = {}, { preserveMutation = false } = {}) {
  const executionContext = currentRunnerExecutionContext();
  const jobKey = executionContext?.jobKey ?? currentQuestStatusContext().jobKey;
  if (!jobKey) return null;
  try {
    if (executionContext?.workerHolder) assertRunnerMutationOwnership(jobKey);
    const current = getRunnerState(jobKey);
    if (
      preserveMutation
      && current?.mutation_status
      && ACTIVE_MUTATION_STATUSES.has(current.mutation_status)
    ) {
      return current;
    }
    return transitionRunnerState(jobKey, state, {
      ...values,
      stateSource: 'quest-orchestrator',
    });
  } catch (error) {
    if (isTerminalRunnerError(error)) throw error;
    console.warn(`[RunnerState:${jobKey}] direct transition failed — ${error?.message ?? 'unknown error'}`);
    return null;
  }
}

export { QuestCompatibilityError };

export function getQuestEngineStatus(statusKey = null) {
  return getStoredQuestStatus(statusKey);
}

export function listQuestEngineStatuses(options = {}) {
  return listStoredQuestStatuses(options);
}

export function clearQuestEngineStatuses() {
  clearStoredQuestStatuses();
}

function recordQuestError(error) {
  const context = currentQuestStatusContext();
  recordQuestFailure(
    context.key,
    error,
    error instanceof QuestCompatibilityError,
    context,
  );
}

export async function fetchMe(token, signal) {
  return fetchCurrentUser(token, signal);
}

async function selectQuestPayload(token, signal) {
  try {
    return await fetchQuestPayload(token, signal);
  } catch (error) {
    if (isAbortFailure(error, signal)) throw abortFailure();
    if (error instanceof QuestCompatibilityError) {
      recordQuestError(error);
      await reportCriticalError('Quest API compatibility', error);
    } else if (isFatalAuthError(error)) {
      recordQuestError(error);
    }
    throw error;
  }
}

async function normalizeQuestPayload(payload) {
  try {
    return normalizeQuestPayloadV2(payload.quests, payload.enrollmentBlockedUntil);
  } catch (error) {
    const compatibilityError = error instanceof QuestCompatibilityError
      ? error
      : new QuestCompatibilityError(`Quest payload could not be parsed: ${error.message}`);
    recordQuestError(compatibilityError);
    await reportCriticalError('Quest API compatibility', compatibilityError);
    throw compatibilityError;
  }
}

function summarizeQuestCompatibility(quests) {
  const unknownEvents = [...new Set(
    quests
      .filter((quest) => questExecutor(quest).id === 'unknown')
      .map((quest) => quest.eventName),
  )];
  return {
    unknownEvents,
    schemaIssues: quests.flatMap((quest) => quest.schemaIssues),
  };
}

async function reportQuestCompatibility(summary) {
  if (!summary.schemaIssues.length && !summary.unknownEvents.length) return;
  const details = [
    ...summary.schemaIssues,
    summary.unknownEvents.length ? `unknown events: ${summary.unknownEvents.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  await reportCriticalError(
    'Quest API compatibility',
    new QuestCompatibilityError(details),
  );
}

export async function fetchQuests(token, signal, explicitStatusContext = null) {
  if (explicitStatusContext) {
    const context = normalizeStatusContext(explicitStatusContext);
    return questStatusStorage.run(context, () => fetchQuests(token, signal));
  }

  const statusContext = currentQuestStatusContext();
  transitionCurrentRunner(RUNNER_STATE.FETCHING_QUESTS, {}, { preserveMutation: true });
  recordQuestAttempt(statusContext.key, statusContext);
  const payload = await selectQuestPayload(token, signal);
  const quests = await normalizeQuestPayload(payload);
  const summary = summarizeQuestCompatibility(quests);

  recordQuestSuccess(statusContext.key, {
    state: summary.schemaIssues.length || summary.unknownEvents.length ? 'degraded' : 'compatible',
    questCount: quests.length,
    excludedCount: payload.excludedCount,
    enrollmentBlockedUntil: payload.enrollmentBlockedUntil,
    supportedCount: quests.filter((quest) => !quest.completed && isRunnableQuest(quest)).length,
    unknownEvents: summary.unknownEvents,
    schemaIssues: summary.schemaIssues,
    questListPath: payload.path,
  }, statusContext);

  await reportQuestCompatibility(summary);
  return quests;
}

async function readFreshQuestForMutation(token, questId, signal) {
  return (await fetchQuests(token, signal)).find((quest) => quest.id === questId) ?? null;
}

async function verifiedQuestMutation({ token, questId, signal, perform, predicate }) {
  return executeVerifiedMutation({
    perform,
    signal,
    verify: async () => {
      const fresh = await readFreshQuestForMutation(token, questId, signal);
      return Boolean(fresh && predicate(fresh));
    },
  });
}

async function enrollQuest(token, questId, signal) {
  return verifiedQuestMutation({
    token,
    questId,
    signal,
    predicate: (fresh) => fresh.enrolled,
    perform: () => enrollQuestRequest(token, questId, signal),
  });
}

async function claimQuest(token, questId, platform, signal) {
  return verifiedQuestMutation({
    token,
    questId,
    signal,
    perform: () => claimQuestRequest(token, questId, platform, signal),
    predicate: (fresh) => fresh.claimed,
  });
}

async function sendVideoProgress(token, questId, timestamp, signal) {
  return verifiedQuestMutation({
    token,
    questId,
    signal,
    predicate: (fresh) => fresh.completed || fresh.progressSecs >= Math.floor(timestamp),
    perform: () => sendVideoProgressRequest(token, questId, timestamp, signal),
  });
}

async function sendGameHeartbeat(token, quest, terminal, signal) {
  const baseline = quest.progressSecs;
  return verifiedQuestMutation({
    token,
    questId: quest.id,
    signal,
    perform: () => sendHeartbeatRequest(token, quest, terminal, false, signal),
    predicate: (fresh) => fresh.completed || fresh.progressSecs > baseline,
  });
}

async function sendApplicationHeartbeat(token, quest, terminal, signal) {
  const baseline = quest.progressSecs;
  return verifiedQuestMutation({
    token,
    questId: quest.id,
    signal,
    predicate: (fresh) => fresh.completed || fresh.progressSecs > baseline,
    perform: () => sendHeartbeatRequest(token, quest, terminal, true, signal),
  });
}

export function normalizeQuest(raw) {
  return normalizeQuestV2(raw);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    let t;
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

async function waitForQuestState(token, questId, predicate, signal, {
  attempts = 3,
  delayMs = 1500,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const fresh = (await fetchQuests(token, signal)).find((quest) => quest.id === questId);
    if (fresh && predicate(fresh)) return fresh;
    if (attempt < attempts) await sleep(delayMs, signal);
  }
  return null;
}

const jobs = new Map();
const activeRunPromises = new Set();

export function getJob(key)   { return jobs.get(key) ?? null; }
export function listJobs()    { return [...jobs.entries()].map(([key, j]) => ({ key, ...j.summary() })); }
export function getUserJobs(ownerId, { mode = null, includeStopping = false } = {}) {
  return [...jobs.entries()]
    .filter(([, job]) => (
      job.ownerId === ownerId
      && (!mode || job.mode === mode)
      && (includeStopping || job.lifecycle !== 'stopping')
    ))
    .map(([key, job]) => ({ key, ...job.summary() }));
}

export function findUserJobByAccount(ownerId, accountId) {
  for (const [key, job] of jobs) {
    if (job.ownerId === ownerId && job.accountId === accountId) {
      return { key, ...job.summary() };
    }
  }
  return null;
}

export function findAnyJobByAccount(accountId) {
  for (const [key, job] of jobs) {
    if (job.accountId === accountId) return { key, ...job.summary() };
  }
  return null;
}

export function stopJob(ownerId, key, { removeSchedule = true } = {}) {
  const job = jobs.get(key);
  if (!job || job.ownerId !== ownerId) return false;
  if (job.lifecycle !== 'stopping') {
    job.lifecycle = 'stopping';
    job.controller.abort();
  }
  if (removeSchedule && job.scheduleId != null) {
    deleteScheduledRunner(job.scheduleId, ownerId);
  }
  return true;
}

export function stopScheduledJob(ownerId, scheduleId) {
  const key = `scheduled:${scheduleId}`;
  const stopped = stopJob(ownerId, key);
  const removed = deleteScheduledRunner(scheduleId, ownerId);
  return stopped || removed;
}

export function stopAllForUser(ownerId, { mode = null } = {}) {
  let count = 0;
  for (const [key, job] of jobs) {
    if (job.ownerId !== ownerId || (mode && job.mode !== mode)) continue;
    if (stopJob(ownerId, key)) count++;
  }
  return count;
}
export function stopRunner(ownerId, options = {}) {
  return stopAllForUser(ownerId, options) > 0;
}

export async function shutdownRunners(timeoutMs = null) {
  const activeJobs = [...jobs.values()];
  for (const job of activeJobs) job.controller.abort();

  await settleWithTimeout(activeRunPromises, timeoutMs, {
    pendingCount: () => activeRunPromises.size,
    timeoutMessage: (count) => `Runner shutdown timed out with ${count} task(s) pending`,
  });
  return activeJobs.length;
}

function nextOneShotState(noProgressRounds, outcome) {
  if (outcome.supportedCount === 0) return { stop: true, noProgressRounds };
  const nextRounds = outcome.progressed ? 0 : noProgressRounds + 1;
  return { stop: nextRounds >= 3, noProgressRounds: nextRounds };
}

function idleQuestOutcome(supportedCount = 0) {
  return { attempted: false, progressed: false, supportedCount };
}

function attemptedQuestOutcome(supportedCount) {
  return { attempted: true, progressed: false, supportedCount };
}

export async function startRunner({
  jobKey,
  ownerId,
  userToken,
  channelId,
  client,
  mode = 'oneshot',
  scheduleId = null,
  accountId: initialAccountId = null,
  username: initialUsername = null,
  initialNextCheckAt = null,
  recoveryPlan = null,
  speedMultiplier = 5,
  heartbeatInterval = 30,
}) {
  if (jobs.has(jobKey)) throw new Error(`Job ${jobKey} กำลังทำงานอยู่`);
  if (!['oneshot', 'scheduled'].includes(mode)) throw new Error(`Unknown runner mode: ${mode}`);

  const controller = new AbortController();
  const { signal } = controller;

  let liveMsg      = null;
  let outputChannel = null;
  let username     = initialUsername ?? '...';
  let accountId    = initialAccountId;
  let lastRenderAt = 0;
  let pendingTimer = null;
  let flushPromise = Promise.resolve();
  let nextCheckAt  = initialNextCheckAt;
  let logoutReported = false;
  let countAlreadyReported = false;
  let oneShotSession = null;
  let oneShotSummaryReported = false;
  const claimRetryAt = new Map();
  const RENDER_THROTTLE_MS = 2000;
  const logLines = [];

  function addLog(line) {
    logLines.push(String(line).slice(0, 180));
    if (logLines.length > 25) logLines.shift();
  }

  async function resolveOutputChannel() {
    if (outputChannel?.isTextBased?.()) return outputChannel;
    let channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.() && config.logChannelId && config.logChannelId !== channelId) {
      channel = await client.channels.fetch(config.logChannelId).catch(() => null);
    }
    if (channel?.isTextBased?.()) outputChannel = channel;
    return outputChannel;
  }

  async function flush() {
    const task = flushPromise.then(async () => {
      lastRenderAt = Date.now();
      const visibleLines = [...logLines];
      let content = '```\n' + visibleLines.join('\n') + '\n```';
      while (content.length > 1950 && visibleLines.length > 1) {
        visibleLines.shift();
        content = '```\n' + visibleLines.join('\n') + '\n```';
      }
      const editingExisting = Boolean(liveMsg);
      try {
        if (!liveMsg) {
          const ch = await resolveOutputChannel();
          if (!ch?.isTextBased?.()) return;
          liveMsg = await ch.send({ content });
        } else {
          await liveMsg.edit({ content });
        }
      } catch (err) {
        if (editingExisting) liveMsg = null;
        console.warn(`[Runner:${jobKey}] status message failed — ${err.message}`);
      }
    });

    flushPromise = task.catch(() => {});
    await task;
  }

  async function render() {
    const now = Date.now();
    if (liveMsg && now - lastRenderAt < RENDER_THROTTLE_MS) {
      if (!pendingTimer) {
        const wait = RENDER_THROTTLE_MS - (now - lastRenderAt);
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          flush();
        }, wait);
        pendingTimer.unref?.();
      }
      return;
    }
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    await flush();
  }

  const runnerStatusContext = normalizeStatusContext({
    key: `job:${jobKey}`,
    ownerId,
    accountId,
    username,
    jobKey,
    mode,
    lifecycle: 'running',
  });
  setQuestStatusLifecycle(runnerStatusContext.key, 'running', runnerStatusContext);

  const jobRecord = {
    ownerId,
    accountId,
    mode,
    scheduleId,
    controller,
    lifecycle: 'running',
    done: null,
    summary: () => ({
      username,
      accountId,
      mode,
      scheduleId,
      questStatusKey: runnerStatusContext.key,
      lifecycle: jobRecord.lifecycle,
      nextCheckAt,
      status: logLines.at(-1) ?? '',
    }),
  };
  jobs.set(jobKey, jobRecord);

  const clearPendingRender = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };
  signal.addEventListener('abort', clearPendingRender, { once: true });

  function persistSchedule(values = {}) {
    if (mode === 'scheduled' && scheduleId != null) {
      updateScheduledRunner(scheduleId, values);
    }
  }

  function rethrowFatalAuth(error) {
    if (isFatalAuthError(error)) throw error;
  }

  async function claimSilently(quest) {
    if (quest.claimed) {
      claimRetryAt.delete(quest.id);
      recordQuestVerification(currentQuestStatusContext().key, 'claim', currentQuestStatusContext());
      transitionCurrentRunner(RUNNER_STATE.RUNNING, {
        questId: quest.id,
        questName: quest.name,
        questEvent: quest.eventName,
        progress: 100,
        serverProgressSeconds: quest.progressSecs,
      });
      return true;
    }

    const retryAt = Math.max(
      claimRetryAt.get(quest.id) ?? 0,
      durableClaimRetryAt(jobKey) ?? 0,
    );
    if (retryAt > Date.now()) return false;
    transitionCurrentRunner(RUNNER_STATE.CLAIMING, {
      questId: quest.id,
      questName: quest.name,
      questEvent: quest.eventName,
      progress: quest.progress,
      serverProgressSeconds: quest.progressSecs,
    });
    const platform = selectQuestClaimPlatform(quest);
    if (platform == null) {
      const retry = classifyClaimRetry(null, { platformAmbiguous: true });
      claimRetryAt.set(quest.id, Date.now() + retry.delayMs);
      persistClaimRetry(jobKey, quest, retry);
      return false;
    }

    try {
      await claimQuest(userToken, quest.id, platform, signal);
      const claimed = await waitForQuestState(
        userToken,
        quest.id,
        (fresh) => fresh.claimed,
        signal,
      );
      if (claimed) {
        claimRetryAt.delete(quest.id);
        recordQuestVerification(currentQuestStatusContext().key, 'claim', currentQuestStatusContext());
        transitionCurrentRunner(RUNNER_STATE.RUNNING, {
          questId: quest.id,
          questName: quest.name,
          questEvent: quest.eventName,
          progress: 100,
          serverProgressSeconds: claimed.progressSecs,
        });
      } else {
        const retry = {
          reason: CLAIM_RETRY_REASON.VERIFICATION_ABSENT,
          delayMs: CLAIM_RETRY_DELAY_MS,
          error: new Error('Discord has not confirmed claimed_at after verification'),
        };
        claimRetryAt.set(quest.id, Date.now() + retry.delayMs);
        persistClaimRetry(jobKey, quest, retry);
      }
      return Boolean(claimed);
    } catch (error) {
      if (isAbortFailure(error, signal)) throw abortFailure();
      rethrowFatalAuth(error);
      if (isTerminalRunnerError(error)) throw error;
      const retry = classifyClaimRetry(error);
      claimRetryAt.set(quest.id, Date.now() + retry.delayMs);
      persistClaimRetry(jobKey, quest, retry);
      return false;
    }
  }

  async function reportOneShotLogout() {
    if (mode !== 'oneshot' || logoutReported) return;
    logoutReported = true;
    addLog(`🔒 LOGOUT : ${username}`);
    await flush();
  }

  async function reportRunnableCount(count) {
    addLog(`🔎 ${username}: พบ ${count} QUESTS`);
    await render();
  }

  function questActivityLine(icon, content) {
    return mode === 'oneshot'
      ? `${icon} ${content}`
      : `${icon} ${username}: ${content}`;
  }

  function oneShotSummary() {
    return getOneShotSessionSummary(oneShotSession);
  }

  async function reportOneShotInitialState() {
    const summary = oneShotSummary();
    addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);
    addLog(`🎉 ${username}: ทำสำเร็จ ${summary.completedByBotCount} QUESTS`);
    addLog('🧹 QUEST ACTIVITY CLEARED');
    await flush();
  }

  async function reportOneShotTerminalState() {
    const summary = oneShotSummary();
    const completedCount = summary.completedByBotCount + summary.completedExternalCount;
    addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);
    addLog(`🎉 ${username}: ทำสำเร็จ ${summary.completedByBotCount} QUESTS`);
    if (completedCount > 0) {
      addLog(`🎁 ${username}: รับรางวัลสำเร็จ ${summary.claimedRewardCount}/${completedCount} QUESTS`);
    }
    addLog('🧹 QUEST ACTIVITY CLEARED');
    await flush();
    return summary;
  }

  function oneShotOutcome() {
    const summary = oneShotSummary();
    return {
      attempted: true,
      progressed: true,
      supportedCount: summary.pendingCount,
    };
  }

  async function reportOneShotFailure(quest, reason) {
    if (mode !== 'oneshot') return null;
    failOneShotQuest(oneShotSession, quest.id, reason);
    await reportOneShotTerminalState();
    return oneShotOutcome();
  }

  async function completeAndClaimOneShotQuest(quest) {
    completeOneShotQuest(oneShotSession, quest.id);
    const claimed = await claimSilently(quest);
    recordOneShotRewardClaim(oneShotSession, quest.id, { claimed });
  }

  async function reportOneShotCompletion() {
    if (mode !== 'oneshot') return null;
    await reportOneShotTerminalState();
    return oneShotOutcome();
  }

  async function reportOneShotSummary() {
    if (mode !== 'oneshot' || oneShotSummaryReported) return;
    oneShotSummaryReported = true;
    const summary = oneShotSummary();
    const completedCount = summary.completedByBotCount + summary.completedExternalCount;
    addLog(`🔎 ${username}: พบ ${summary.totalSupportedQuests} QUESTS`);
    addLog(`🎉 ${username}: ทำสำเร็จ ${summary.completedByBotCount} QUESTS`);
    if (completedCount > 0) {
      addLog(`🎁 ${username}: รับรางวัลสำเร็จ ${summary.claimedRewardCount}/${completedCount} QUESTS`);
    }
    addLog('🧹 QUEST ACTIVITY CLEARED');

    if (summary.totalSupportedQuests === 0) {
      addLog('ℹ️ ไม่พบ Quest ที่บอทสามารถทำได้ในขณะนี้');
      await flush();
      return;
    }

    if (summary.issues.length === 0
        && summary.claimPendingCount === 0
        && summary.completedByBotCount === summary.totalSupportedQuests) {
      addLog('🎉 บอทได้เข้าไปทำ Quest และรับรางวัลทั้งหมดเสร็จสิ้นแล้ว');
      await flush();
      return;
    }

    if (summary.completedByBotCount === summary.totalSupportedQuests
        && summary.claimPendingCount > 0) {
      addLog('⚠️ Quest เสร็จแล้ว แต่มีรางวัลที่ยังรับไม่สำเร็จ');
    } else {
      addLog(summary.completedByBotCount === 0
        ? '❌ บอทไม่สามารถดำเนินการ Quest ให้สำเร็จได้'
        : '⚠️ มีบาง Quest ที่บอทดำเนินการไม่สำเร็จ');
    }
    summary.issues.forEach((issue, index) => {
      addLog(`${index + 1}. ${issue.name}`);
      addLog(`   └ ${issue.reason}`);
    });
    await flush();
  }

  async function prepareOneShotRound(allQuests) {
    if (!oneShotSession) {
      const initialRunnable = allQuests.filter(
        (quest) => !quest.completed && isRunnableQuest(quest),
      );
      oneShotSession = createOneShotQuestSession(initialRunnable);
      await reportOneShotInitialState();
    }
    if (isOneShotSessionComplete(oneShotSession)) {
      return { outcome: idleQuestOutcome() };
    }

    const initialQuest = getNextPendingOneShotQuest(oneShotSession);
    if (!initialQuest) return { outcome: idleQuestOutcome() };
    return { runnable: [initialQuest], initialQuest };
  }

  async function claimScheduledCompletions(allQuests) {
    const completed = allQuests.filter((quest) => quest.completed && !quest.claimed);
    for (const quest of completed) {
      if (signal.aborted) throw new Error('aborted');
      await claimSilently(quest);
    }
  }

  async function prepareScheduledRound(allQuests) {
    await claimScheduledCompletions(allQuests);
    const runnable = allQuests.filter((quest) => !quest.completed && isRunnableQuest(quest));
    if (!countAlreadyReported) await reportRunnableCount(runnable.length);
    countAlreadyReported = false;
    if (runnable.length === 0) return { outcome: idleQuestOutcome() };
    return { runnable, initialQuest: runnable[0] };
  }

  function prepareQuestRound(allQuests) {
    return mode === 'oneshot'
      ? prepareOneShotRound(allQuests)
      : prepareScheduledRound(allQuests);
  }

  async function refreshRoundQuest(selection) {
    try {
      return {
        quest: await fetchFreshQuest(userToken, selection.initialQuest.id, signal),
      };
    } catch (error) {
      rethrowFatalAuth(error);
      if (isTerminalRunnerError(error)) throw error;
      if (mode === 'oneshot') {
        return {
          outcome: await reportOneShotFailure(
            selection.initialQuest,
            oneShotFreshQuestFailureReason(error),
          ),
        };
      }
      addLog(`⚠️ ${username}: refresh failed — ${selection.initialQuest.name} — ${error.message}`);
      await render();
      return { outcome: attemptedQuestOutcome(selection.runnable.length) };
    }
  }

  async function resolveQuestAvailability(quest, selection) {
    if (!quest.completed && isRunnableQuest(quest)) return null;
    if (quest.completed) {
      if (mode === 'oneshot') {
        await completeAndClaimOneShotQuest(quest);
        return reportOneShotCompletion();
      }
      return idleQuestOutcome(selection.runnable.length);
    }
    if (mode === 'oneshot') {
      return reportOneShotFailure(quest, oneShotUnavailableReason(quest));
    }
    return idleQuestOutcome(selection.runnable.length);
  }

  async function announceQuestPreparation(quest) {
    if (mode === 'oneshot') {
      markOneShotQuestRunning(oneShotSession, quest.id, quest.progressSecs);
    }
    addLog(questActivityLine('⏭️', `กำลังเตรียมทำ ${quest.name}`));
    await render();
  }

  async function questFailureOutcome(quest, selection, reason, scheduledMessage) {
    if (mode === 'oneshot') return reportOneShotFailure(quest, reason);
    addLog(scheduledMessage);
    await render();
    return attemptedQuestOutcome(selection.runnable.length);
  }

  async function ensureQuestEnrollment(quest, selection) {
    if (quest.enrolled) return { quest };
    transitionCurrentRunner(RUNNER_STATE.ENROLLING, {
      questId: quest.id,
      questName: quest.name,
      questEvent: quest.eventName,
      progress: quest.progress,
      serverProgressSeconds: quest.progressSecs,
    });
    try {
      await enrollQuest(userToken, quest.id, signal);
      const enrolled = await waitForQuestState(
        userToken,
        quest.id,
        (fresh) => fresh.enrolled,
        signal,
      );
      if (enrolled) {
        transitionCurrentRunner(RUNNER_STATE.RUNNING, {
          questId: enrolled.id,
          questName: enrolled.name,
          questEvent: enrolled.eventName,
          progress: enrolled.progress,
          serverProgressSeconds: enrolled.progressSecs,
        });
        return { quest: enrolled };
      }
      return {
        outcome: await questFailureOutcome(
          quest,
          selection,
          'Discord ยังไม่ยืนยันการรับ Quest',
          `⚠️ ${username}: ${quest.name} — Discord ยังไม่ยืนยันการรับ Quest`,
        ),
      };
    } catch (error) {
      rethrowFatalAuth(error);
      if (isTerminalRunnerError(error)) throw error;
      const reason = questActionFailureReason(error, 'รับ Quest');
      return {
        outcome: await questFailureOutcome(
          quest,
          selection,
          reason,
          `⚠️ ${username}: ${quest.name} — ${reason}`,
        ),
      };
    }
  }

  async function announceQuestProgress(quest) {
    transitionCurrentRunner(RUNNER_STATE.RUNNING_PROGRESS, {
      questId: quest.id,
      questName: quest.name,
      questEvent: quest.eventName,
      progress: quest.progress,
      serverProgressSeconds: quest.progressSecs,
    });
    addLog(questActivityLine('▶️', `กำลังทำ ${quest.name}`));
    const initialPercent = Math.min(100, Math.max(0, Math.floor(quest.progress)));
    addLog(questActivityLine('⌛', `${quest.name} ${initialPercent}%`));
    await render();
    return initialPercent;
  }

  function createQuestProgressHooks(quest, initialPercent) {
    let nextCheckpoint = Math.max(25, (Math.floor(initialPercent / 25) + 1) * 25);
    let lastReportedPercent = initialPercent;
    let lastVerifiedProgressSecs = quest.progressSecs;
    let completionSeen = quest.completed;

    const onServerProgress = async (fresh) => {
      const percent = fresh.completed ? 100 : Math.min(100, Math.floor(fresh.progress));
      if (fresh.progressSecs > lastVerifiedProgressSecs || (fresh.completed && !completionSeen)) {
        recordQuestVerification(
          currentQuestStatusContext().key,
          'progress',
          currentQuestStatusContext(),
        );
      }
      if (mode === 'oneshot') {
        recordOneShotVerifiedProgress(
          oneShotSession,
          quest.id,
          fresh.progressSecs,
          { completed: fresh.completed },
        );
      }
      lastVerifiedProgressSecs = Math.max(lastVerifiedProgressSecs, fresh.progressSecs);
      completionSeen ||= fresh.completed;
      transitionCurrentRunner(
        fresh.completed ? RUNNER_STATE.VERIFYING_COMPLETION : RUNNER_STATE.RUNNING_PROGRESS,
        {
          questId: fresh.id,
          questName: fresh.name,
          questEvent: fresh.eventName,
          progress: percent,
          serverProgressSeconds: fresh.progressSecs,
        },
      );
      while (nextCheckpoint <= 100 && percent >= nextCheckpoint) {
        if (nextCheckpoint > lastReportedPercent) {
          addLog(questActivityLine('⌛', `${quest.name} ${nextCheckpoint}%`));
          lastReportedPercent = nextCheckpoint;
        }
        nextCheckpoint += 25;
      }
      await render();
    };

    const onMutationAccepted = () => {
      if (mode === 'oneshot') {
        markOneShotProgressMutationSent(oneShotSession, quest.id);
      }
    };

    return { onServerProgress, onMutationAccepted };
  }

  async function executeQuestProgress(quest, selection, hooks) {
    const executor = questExecutor(quest);
    try {
      const execution = await executeQuestExecutor(executor, {
        quest,
        signal,
        heartbeatInterval,
        sleep,
        fetchFreshQuest: (questId, executorSignal) => fetchFreshQuest(
          userToken,
          questId,
          executorSignal,
        ),
        sendVideoProgress: (questId, timestamp, executorSignal) => sendVideoProgress(
          userToken,
          questId,
          timestamp,
          executorSignal,
        ),
        sendHeartbeat: (
          executorQuest,
          terminal,
          useApplicationPayload,
          executorSignal,
        ) => sendQuestHeartbeat(
          userToken,
          executorQuest,
          terminal,
          useApplicationPayload,
          executorSignal,
        ),
        onServerProgress: hooks.onServerProgress,
        onMutationAccepted: hooks.onMutationAccepted,
      });
      if (!execution.verified) {
        throw new QuestCompatibilityError(
          `Quest executor ${executor.id} did not return verified completion`,
        );
      }
      if (signal.aborted) throw new Error('aborted');
      return null;
    } catch (error) {
      rethrowFatalAuth(error);
      if (signal.aborted) throw new Error('aborted');
      if (isTerminalRunnerError(error)) throw error;
      if (mode === 'oneshot') {
        return reportOneShotFailure(
          quest,
          questActionFailureReason(error, 'ส่งความคืบหน้า'),
        );
      }
      if (error.message !== 'aborted') {
        addLog(`⚠️ ${username}: ERROR ${questActionFailureReason(error, 'ส่งความคืบหน้า')}`);
      }
      await render();
      return attemptedQuestOutcome(selection.runnable.length);
    }
  }

  async function verifyQuestCompletion(quest, selection) {
    transitionCurrentRunner(RUNNER_STATE.VERIFYING_COMPLETION, {
      questId: quest.id,
      questName: quest.name,
      questEvent: quest.eventName,
      progress: quest.progress,
      serverProgressSeconds: quest.progressSecs,
    });
    try {
      const fresh = await waitForQuestState(
        userToken,
        quest.id,
        (item) => item.completed,
        signal,
      );
      if (fresh) return { fresh };
      return {
        outcome: await questFailureOutcome(
          quest,
          selection,
          'Discord ยังไม่ยืนยันสถานะเสร็จ',
          `⚠️ ${username}: ${quest.name} — Discord ยังไม่ส่ง completed_at หลังตรวจ 3 ครั้ง`,
        ),
      };
    } catch (error) {
      rethrowFatalAuth(error);
      if (isTerminalRunnerError(error)) throw error;
      const reason = questActionFailureReason(error, 'ตรวจสอบผลลัพธ์กับ Discord');
      return {
        outcome: await questFailureOutcome(
          quest,
          selection,
          reason,
          `⚠️ ${username}: ${reason}`,
        ),
      };
    }
  }

  async function finalizeQuestCompletion(fresh, hooks) {
    await hooks.onServerProgress(fresh);
    recordQuestVerification(
      currentQuestStatusContext().key,
      'completion',
      currentQuestStatusContext(),
    );

    if (mode === 'oneshot') {
      await completeAndClaimOneShotQuest(fresh);
      return reportOneShotCompletion();
    }

    await claimSilently(fresh);
    const latestQuests = await fetchQuests(userToken, signal);
    const supportedRemaining = latestQuests.filter(
      (item) => !item.completed && isRunnableQuest(item),
    ).length;
    await reportRunnableCount(supportedRemaining);
    countAlreadyReported = true;
    return { attempted: true, progressed: true, supportedCount: supportedRemaining };
  }

  async function runQuestRound() {
    const selection = await prepareQuestRound(await fetchQuests(userToken, signal));
    if (selection.outcome) return selection.outcome;

    const refreshed = await refreshRoundQuest(selection);
    if (refreshed.outcome) return refreshed.outcome;

    const availabilityOutcome = await resolveQuestAvailability(refreshed.quest, selection);
    if (availabilityOutcome) return availabilityOutcome;

    await announceQuestPreparation(refreshed.quest);
    const enrollment = await ensureQuestEnrollment(refreshed.quest, selection);
    if (enrollment.outcome) return enrollment.outcome;

    const initialPercent = await announceQuestProgress(enrollment.quest);
    const hooks = createQuestProgressHooks(enrollment.quest, initialPercent);
    const progressOutcome = await executeQuestProgress(enrollment.quest, selection, hooks);
    if (progressOutcome) return progressOutcome;

    const verification = await verifyQuestCompletion(enrollment.quest, selection);
    if (verification.outcome) return verification.outcome;
    return finalizeQuestCompletion(verification.fresh, hooks);
  }

  async function initializeRunnerSession() {
    if (!accountId || !initialUsername) {
      const me = await fetchMe(userToken, signal);
      username = me.username ?? 'unknown';
      accountId = me.id ?? accountId;
    }
    const job = jobs.get(jobKey);
    if (job) job.accountId = accountId;
    Object.assign(runnerStatusContext, { accountId, username });
    setQuestStatusLifecycle(runnerStatusContext.key, 'running', runnerStatusContext);
    addLog(`✅ LOGIN : ${username}`);
    if (mode === 'scheduled') {
      addLog('🤖 AUTO DAILY ENABLED — CHECK 00:00 / 08:00 / 16:00');
    }
    await render();
  }

  async function restoreInitialSchedule() {
    if (mode !== 'scheduled' || !initialNextCheckAt) return;
    const restoredAt = new Date(initialNextCheckAt);
    if (!Number.isFinite(restoredAt.getTime()) || restoredAt.getTime() <= Date.now()) return;
    nextCheckAt = restoredAt.toISOString();
    addLog(`⏰ ${username}: NEXT CHECK ${formatScheduleTime(restoredAt)}`);
    await render();
    await sleep(restoredAt.getTime() - Date.now(), signal);
  }

  async function recoverDurableCheckpoint() {
    if (mode !== 'scheduled' || !recoveryPlan) return;
    if (!['VERIFY_MUTATION', 'VERIFY_COMPLETION'].includes(recoveryPlan.action)) return;

    const quests = await fetchDurableRecoveryQuests({
      fetchQuests,
      userToken,
      signal,
      isFatalAuthError,
      onDeferred: async () => {
        addLog(`⚠️ ${username}: RECOVERY DEFERRED — RETRY IN NORMAL LOOP`);
        await render();
      },
    });
    if (!quests) return;
    if (recoveryPlan.action === 'VERIFY_MUTATION') {
      const result = verifyRunnerMutationFromQuests(jobKey, quests, { finalizeAbsent: true });
      addLog(result.verified
        ? `✅ ${username}: RECOVERY VERIFIED — ${recoveryPlan.mutationKind ?? 'MUTATION'}`
        : `🔄 ${username}: RECOVERY CHECKED — RESUME FROM SERVER STATE`);
      await render();
      return;
    }

    const quest = quests.find((item) => item.id === recoveryPlan.questId);
    transitionCurrentRunner(
      quest?.completed ? RUNNER_STATE.VERIFYING_COMPLETION : RUNNER_STATE.RUNNING,
      {
        questId: quest?.id ?? recoveryPlan.questId ?? null,
        questName: quest?.name ?? null,
        questEvent: quest?.eventName ?? null,
        progress: quest?.progress ?? null,
        serverProgressSeconds: quest?.progressSecs ?? null,
      },
    );
  }

  async function runRoundSafely() {
    try {
      const outcome = await runQuestRound();
      persistSchedule({ lastCheckAt: new Date().toISOString(), lastError: null });
      return outcome;
    } catch (error) {
      if (
        error.message === 'aborted'
        || isFatalAuthError(error)
        || isTerminalRunnerError(error)
        || mode === 'oneshot'
      ) {
        throw error;
      }
      addLog(`⚠️ ${username}: CHECK ERROR — ${error.message}`);
      await render();
      persistSchedule({
        lastCheckAt: new Date().toISOString(),
        lastError: error.message,
      });
      return {
        attempted: false,
        progressed: false,
        supportedCount: 0,
        transientError: true,
        retryError: error,
      };
    }
  }

  async function waitForTransientErrorRetry(attempt, error) {
    const delayMs = transientRetryDelayMs(attempt);
    nextCheckAt = new Date(Date.now() + delayMs).toISOString();
    persistSchedule({ nextCheckAt });
    transitionCurrentRunner(RUNNER_STATE.WAITING_RETRY, {
      nextActionAt: nextCheckAt,
      lastError: error?.message ?? String(error ?? 'transient runner error'),
    });
    addLog(`🌐 ${username}: NETWORK RETRY — อีก ${Math.round(delayMs / 60_000)} นาที`);
    await render();
    countAlreadyReported = false;
    await sleep(delayMs, signal);
    return attempt + 1;
  }

  async function waitForVerificationRecheck(state, outcome) {
    const recheck = nextRecheckState({
      isRecheck: state.isRecheck,
      rechecksRemaining: state.rechecksRemaining,
      attempted: outcome.attempted,
      progressed: outcome.progressed,
    });
    if (!recheck.shouldRecheck) return null;

    const checkNumber = 4 - recheck.rechecksRemaining;
    nextCheckAt = new Date(Date.now() + RECHECK_INTERVAL_MS).toISOString();
    persistSchedule({ nextCheckAt });
    addLog(`🔁 ${username}: VERIFY ${checkNumber}/3 — อีก 5 นาที`);
    await render();
    countAlreadyReported = false;
    await sleep(RECHECK_INTERVAL_MS, signal);
    return { isRecheck: true, rechecksRemaining: recheck.rechecksRemaining };
  }

  async function waitForNextScheduledCheck() {
    const scheduledAt = addScheduleJitter(
      nextScheduledCheck(new Date(), config.timezone),
    );
    nextCheckAt = scheduledAt.toISOString();
    persistSchedule({ nextCheckAt });
    addLog(`💤 ${username}: AUTO DAILY ACTIVE`);
    addLog(`⏰ ${username}: NEXT CHECK ${formatScheduleTime(scheduledAt)}`);
    await render();
    countAlreadyReported = false;
    await sleep(scheduledAt.getTime() - Date.now(), signal);
  }

  async function handleScheduledIdle(state, outcome) {
    const recheckState = await waitForVerificationRecheck(state, outcome);
    if (recheckState) return recheckState;
    await waitForNextScheduledCheck();
    return { isRecheck: false, rechecksRemaining: 0 };
  }

  async function runQuestLoop() {
    let noProgressRounds = 0;
    let scheduleState = { isRecheck: false, rechecksRemaining: 0 };
    let transientErrorAttempts = 0;

    while (!signal.aborted) {
      const outcome = await runRoundSafely();
      if (mode === 'oneshot') {
        const oneShotState = nextOneShotState(noProgressRounds, outcome);
        noProgressRounds = oneShotState.noProgressRounds;
        if (oneShotState.stop) break;
        continue;
      }
      if (outcome.transientError) {
        transientErrorAttempts = await waitForTransientErrorRetry(
          transientErrorAttempts,
          outcome.retryError,
        );
        continue;
      }
      transientErrorAttempts = 0;
      if (outcome.progressed && outcome.supportedCount > 0) continue;
      scheduleState = await handleScheduledIdle(scheduleState, outcome);
    }
  }

  async function handleRunnerFailure(error) {
    if (error.message === 'aborted') {
      if (mode === 'scheduled') {
        addLog(`🛑 ${username}: STOPPED BY USER`);
        await render();
      }
      return;
    }
    if (isFatalAuthError(error)) {
      addLog(`🔐 ${username}: TOKEN INVALID — RUNNER DISABLED (${error.status})`);
      await render();
      if (scheduleId != null) deleteScheduledRunner(scheduleId, ownerId);
      await reportCriticalError(
        'Runner authentication',
        new Error(`${username}: Discord API ${error.status}; runner disabled`),
      );
      return;
    }
    addLog(`❌ ${username}: ${questActionFailureReason(error, 'Runner')}`);
    await render();
    persistSchedule({ lastError: error.message });
  }

  async function cleanupRunnerSession() {
    try {
      await reportOneShotLogout();
      signal.removeEventListener('abort', clearPendingRender);
      const hadPendingRender = Boolean(pendingTimer);
      clearPendingRender();
      await flushPromise;
      if (hadPendingRender) await flush();
      setQuestStatusLifecycle(runnerStatusContext.key, 'stopped', {
        ...runnerStatusContext,
        accountId,
        username,
      });
    } finally {
      jobs.delete(jobKey);
    }
  }

  async function executeRunnerLifecycle() {
    try {
      await initializeRunnerSession();
      await restoreInitialSchedule();
      await recoverDurableCheckpoint();
      await runQuestLoop();
      await reportOneShotSummary();
    } catch (error) {
      await handleRunnerFailure(error);
    } finally {
      await cleanupRunnerSession();
    }
  }

  const runPromise = questStatusStorage.run(
    runnerStatusContext,
    executeRunnerLifecycle,
  );

  const currentJob = jobs.get(jobKey);
  if (currentJob) currentJob.done = runPromise;
  activeRunPromises.add(runPromise);
  void runPromise.then(
    () => activeRunPromises.delete(runPromise),
    () => activeRunPromises.delete(runPromise),
  );

  return { jobKey, mode, scheduleId };
}

function formatScheduleTime(date) {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: config.timezone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

export async function restoreScheduledRunners(client) {
  const rows = listScheduledRunners();
  if (!rows.length) return { restored: 0, failed: 0 };

  if (!config.runnerTokenSecret || config.runnerTokenSecret.length < 16) {
    console.warn('⚠️ Scheduled Runner restore skipped — RUNNER_TOKEN_SECRET missing/too short');
    return { restored: 0, failed: rows.length };
  }

  let restored = 0;
  let failed = 0;
  const restoredByOwner = new Map();
  const restoredAccounts = new Set();

  for (const row of rows) {
    const ownerCount = restoredByOwner.get(row.owner_id) ?? 0;
    if (ownerCount >= 10) {
      failed++;
      updateScheduledRunner(row.id, {
        lastError: 'Restore skipped: owner runner limit exceeded',
      });
      continue;
    }
    if (restoredAccounts.has(row.account_id)) {
      failed++;
      updateScheduledRunner(row.id, {
        lastError: 'Restore skipped: Discord account already restored',
      });
      continue;
    }

    try {
      const token = decryptRunnerToken(row, config.runnerTokenSecret);
      await startRunner({
        jobKey: `scheduled:${row.id}`,
        ownerId: row.owner_id,
        userToken: token,
        channelId: row.channel_id,
        client,
        mode: 'scheduled',
        scheduleId: row.id,
        accountId: row.account_id,
        username: row.username,
        initialNextCheckAt: row.next_check_at,
      });
      restored++;
      restoredByOwner.set(row.owner_id, ownerCount + 1);
      restoredAccounts.add(row.account_id);
    } catch (err) {
      failed++;
      updateScheduledRunner(row.id, { lastError: `Restore failed: ${err.message}` });
      await reportCriticalError(`Restore Scheduled Runner #${row.id}`, err);
    }
  }

  console.log(`♻️ Scheduled Runners restored: ${restored}, failed: ${failed}`);
  return { restored, failed };
}

async function fetchFreshQuest(token, questId, signal) {
  const fresh = (await fetchQuests(token, signal)).find((item) => item.id === questId);
  if (!fresh) throw new QuestCompatibilityError(`Quest ${questId} disappeared from Quest API`);
  return fresh;
}

async function sendQuestHeartbeat(token, quest, terminal, useApplicationPayload, signal) {
  if (useApplicationPayload) {
    return sendApplicationHeartbeat(token, quest, terminal, signal);
  }
  return sendGameHeartbeat(token, quest, terminal, signal);
}
