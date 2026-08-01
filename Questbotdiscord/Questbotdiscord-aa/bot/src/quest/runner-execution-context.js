import { AsyncLocalStorage } from 'node:async_hooks';
import { authorizationFingerprint } from './authorization-fingerprint.js';

const storage = new AsyncLocalStorage();
const jobsByAccount = new Map();
const contextsByJob = new Map();

function publicContext(context) {
  if (!context) return null;
  return {
    jobKey: context.jobKey,
    ownerId: context.ownerId ?? null,
    accountId: context.accountId ?? null,
    username: context.username ?? null,
    mode: context.mode ?? null,
    scheduleId: context.scheduleId ?? null,
    workerHolder: context.workerHolder ?? null,
    accountKey: context.accountKey,
  };
}

export function createRunnerExecutionContext(args) {
  if (!args?.jobKey) throw new TypeError('Runner execution context requires jobKey');
  return Object.freeze({
    jobKey: args.jobKey,
    ownerId: args.ownerId ?? null,
    accountId: args.accountId ?? null,
    username: args.username ?? null,
    mode: args.mode ?? 'oneshot',
    scheduleId: args.scheduleId ?? null,
    workerHolder: args.workerHolder ?? null,
    accountKey: args.userToken ? authorizationFingerprint(args.userToken) : null,
  });
}

function clearPreviousJobAccountMapping(context) {
  const previous = contextsByJob.get(context.jobKey);
  if (
    previous?.accountKey
    && previous.accountKey !== context.accountKey
    && jobsByAccount.get(previous.accountKey) === context.jobKey
  ) {
    jobsByAccount.delete(previous.accountKey);
  }
}

export function registerRunnerExecution(args) {
  const context = createRunnerExecutionContext(args);
  const existing = context.accountKey ? jobsByAccount.get(context.accountKey) : null;
  if (existing && existing !== context.jobKey) {
    throw new Error(`Authorization fingerprint is already registered to ${existing}`);
  }
  clearPreviousJobAccountMapping(context);
  if (context.accountKey) jobsByAccount.set(context.accountKey, context.jobKey);
  contextsByJob.set(context.jobKey, context);
  let active = true;
  return {
    context: publicContext(context),
    release() {
      if (!active) return false;
      active = false;
      if (context.accountKey && jobsByAccount.get(context.accountKey) === context.jobKey) {
        jobsByAccount.delete(context.accountKey);
      }
      if (contextsByJob.get(context.jobKey) === context) contextsByJob.delete(context.jobKey);
      return true;
    },
  };
}

export function runWithRunnerExecutionContext(context, callback) {
  if (!context?.jobKey) throw new TypeError('Runner execution context requires jobKey');
  return storage.run(Object.freeze({ ...context }), callback);
}

export function currentRunnerExecutionContext() {
  return publicContext(storage.getStore());
}

export function resolveRunnerJobKey(accountKey) {
  return accountKey ? jobsByAccount.get(accountKey) ?? null : null;
}

export function resolveRunnerExecutionContext(jobKey) {
  return publicContext(contextsByJob.get(jobKey));
}

export function resolveRunnerJobKeyFromAuthorization(value) {
  return resolveRunnerJobKey(authorizationFingerprint(value));
}

export function clearRunnerExecutionContextsForTests() {
  jobsByAccount.clear();
  contextsByJob.clear();
}
