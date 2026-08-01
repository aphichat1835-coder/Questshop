import { discordRateLimitCoordinator } from './rate-limit-coordinator.js';

export const DISCORD_API_VERSION = 10;
export const DISCORD_API_BASE = `https://discord.com/api/v${DISCORD_API_VERSION}`;

let installed = false;
let previousGlobalFetch = null;
let transportFetch = null;

function isDiscordApiUrl(url) {
  return url.origin === 'https://discord.com' && /^\/api\/v\d+(?:\/|$)/.test(url.pathname);
}

function coordinatedDiscordApiUrl(input) {
  const source = input instanceof Request ? input.url : String(input);
  const url = new URL(source);
  if (!isDiscordApiUrl(url)) return { input, url: source, coordinated: false };
  return { input, url: source, coordinated: true };
}

function schedulingOptions(input, options) {
  return {
    ...options,
    method: options.method ?? (input instanceof Request ? input.method : undefined),
    headers: options.headers ?? (input instanceof Request ? input.headers : undefined),
  };
}

export function installDiscordApiRuntime({
  fetchFn = globalThis.fetch,
  coordinator = discordRateLimitCoordinator,
} = {}) {
  if (installed) return false;
  if (typeof fetchFn !== 'function') throw new TypeError('Global fetch is unavailable');
  if (typeof coordinator?.schedule !== 'function') {
    throw new TypeError('Discord API coordinator must provide schedule()');
  }

  previousGlobalFetch = globalThis.fetch;
  transportFetch = fetchFn.bind(globalThis);
  globalThis.fetch = async (input, options = {}) => {
    const request = coordinatedDiscordApiUrl(input);
    if (!request.coordinated) return transportFetch(input, options);
    return coordinator.schedule(
      request.url,
      schedulingOptions(input, options),
      () => transportFetch(request.input, options),
    );
  };
  installed = true;
  return true;
}

export function uninstallDiscordApiRuntime() {
  if (!installed) return false;
  globalThis.fetch = previousGlobalFetch;
  installed = false;
  previousGlobalFetch = null;
  transportFetch = null;
  return true;
}

export function getDiscordApiRuntimeStatus() {
  return {
    installed,
    apiVersion: DISCORD_API_VERSION,
    apiBase: DISCORD_API_BASE,
    preservesRequestedVersion: true,
    rateLimit: discordRateLimitCoordinator.snapshot(),
  };
}
