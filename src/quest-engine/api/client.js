import { setTimeout as delay } from 'node:timers/promises';
import { secureJitter } from '../../shared/random.js';
import { extractQuestArray, QuestCompatibilityError } from '../schema/compatibility.js';
import { normalizeQuestPayload } from '../schema/normalizer.js';
import { discordRateLimitCoordinator } from '../rate-limits/coordinator.js';
import { QUEST_ENDPOINT, QUEST_LIST_PATHS } from './endpoints.js';

const API_BASE = new URL('https://discord.com/api/v10');

export class DiscordApiError extends Error {
  constructor(status, path, data) {
    super(`Discord API ${status} at ${path}`);
    this.name = 'DiscordApiError';
    this.status = status;
    this.path = path;
    this.data = data;
    this.fatalAuth = status === 401 || status === 403;
  }
}

function safePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
    || path.includes('\\') || path.includes('?') || path.includes('#')
    || /\/(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(path)) {
    throw new TypeError('unsafe Discord API path');
  }
  return path;
}

function apiUrl(path) {
  const url = new URL(API_BASE);
  url.pathname = `${API_BASE.pathname}${safePath(path)}`;
  return url;
}

function headers(token, path, profile) {
  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/${profile.clientVersion} Chrome/${profile.chromeVersion} Electron/${profile.electronVersion} Safari/537.36`;
  const superProperties = Buffer.from(JSON.stringify({
    os: 'Windows', browser: 'Discord Client', release_channel: 'stable',
    client_version: profile.clientVersion, os_version: '10.0.22631', os_arch: 'x64',
    app_arch: 'x64', system_locale: profile.locale, browser_user_agent: userAgent,
    browser_version: profile.chromeVersion, client_build_number: profile.buildNumber,
    native_build_number: profile.nativeBuildNumber, client_event_source: null, design_id: 0,
  })).toString('base64');
  return {
    authorization: token,
    'content-type': 'application/json',
    'user-agent': userAgent,
    'x-super-properties': superProperties,
    'x-discord-locale': profile.locale,
    'x-discord-timezone': 'Asia/Bangkok',
    accept: '*/*',
    origin: 'https://discord.com',
    referer: path.startsWith('/quests/') ? 'https://discord.com/quest-home' : 'https://discord.com/channels/@me',
  };
}

function retryAfterMs(response, data) {
  const seconds = Number(data?.retry_after ?? response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1000;
}

export function createQuestApiClient({ token, profile, coordinator = discordRateLimitCoordinator }) {
  async function request(path, options = {}, { safeRead = false, maxAttempts = safeRead ? 5 : 1 } = {}) {
    const method = String(options.method ?? 'GET').toUpperCase();
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await coordinator.schedule({
        token,
        signal: options.signal,
        execute: () => fetch(apiUrl(path), {
          ...options,
          headers: { ...headers(token, path, profile), ...options.headers },
        }),
      });
      const text = response.status === 204 ? '' : await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (response.ok) return data ?? { ok: true, status: response.status };
      if (response.status === 429) {
        const wait = retryAfterMs(response, data);
        if (data?.global) coordinator.blockGlobally(wait);
        if (safeRead && attempt + 1 < maxAttempts) {
          await delay(wait, undefined, { signal: options.signal, ref: false });
          continue;
        }
      }
      if (safeRead && response.status >= 500 && attempt + 1 < maxAttempts) {
        await delay(secureJitter(Math.min(30_000, 500 * (2 ** attempt))), undefined, {
          signal: options.signal, ref: false,
        });
        continue;
      }
      throw new DiscordApiError(response.status, path, data);
    }
    throw new Error(`${method} ${path} retry budget exhausted`);
  }

  async function fetchQuestPayload(signal) {
    let empty = null;
    let lastError;
    for (const path of QUEST_LIST_PATHS) {
      try {
        const candidate = await request(path, { signal }, { safeRead: true });
        const payload = {
          path,
          quests: extractQuestArray(candidate, path),
          enrollmentBlockedUntil: candidate?.quest_enrollment_blocked_until ?? null,
        };
        if (payload.quests.length) return payload;
        empty ??= payload;
      } catch (error) {
        if (error?.name === 'AbortError' || [401, 403].includes(error?.status)) throw error;
        lastError = error;
      }
    }
    if (empty) return empty;
    throw new QuestCompatibilityError(`Quest endpoints unavailable: ${lastError?.message ?? 'unknown'}`);
  }

  async function fetchQuests(signal) {
    const payload = await fetchQuestPayload(signal);
    return normalizeQuestPayload(payload.quests, payload.enrollmentBlockedUntil);
  }

  return Object.freeze({
    fetchCurrentUser: (signal) => request(QUEST_ENDPOINT.me(), { signal }, { safeRead: true }),
    fetchQuests,
    enroll: (questId, signal) => request(QUEST_ENDPOINT.enroll(questId), {
      method: 'POST', body: JSON.stringify({ location: 11, is_targeted: false, metadata_raw: null }), signal,
    }),
    sendVideoProgress: (questId, timestamp, signal) => request(QUEST_ENDPOINT.videoProgress(questId), {
      method: 'POST', body: JSON.stringify({ timestamp: Math.floor(timestamp) }), signal,
    }),
    sendHeartbeat: (quest, terminal, useApplicationPayload, signal) => request(QUEST_ENDPOINT.heartbeat(quest.id), {
      method: 'POST',
      body: JSON.stringify(useApplicationPayload
        ? { application_id: quest.applicationId, terminal: Boolean(terminal) }
        : { stream_key: `call:${quest.id}:1`, terminal: Boolean(terminal) }),
      signal,
    }),
  });
}

export function profileFromEnv(env) {
  return Object.freeze({
    clientVersion: env.DISCORD_CLIENT_VERSION,
    chromeVersion: env.DISCORD_CHROME_VERSION,
    electronVersion: env.DISCORD_ELECTRON_VERSION,
    buildNumber: env.DISCORD_BUILD_NUMBER,
    nativeBuildNumber: env.DISCORD_NATIVE_BUILD_NUMBER,
    locale: env.DISCORD_LOCALE,
  });
}
