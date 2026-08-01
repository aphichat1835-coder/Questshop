const ALLOWED_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'canary.discord.com',
  'ptb.discord.com',
  'discordapp.com',
  'canary.discordapp.com',
  'ptb.discordapp.com',
]);
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export function validateDiscordWebhookUrl(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid environment configuration: ${name} must be a valid URL`);
  }

  const pathMatch = /^\/api\/webhooks\/(\d{17,20})\/([A-Za-z0-9._-]{20,})\/?$/.exec(url.pathname);
  if (
    url.protocol !== 'https:'
    || !ALLOWED_WEBHOOK_HOSTS.has(url.hostname)
    || !pathMatch
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
  ) {
    throw new Error(
      `Invalid environment configuration: ${name} must be a standard HTTPS Discord incoming webhook URL`,
    );
  }
  return url.toString().replace(/\/$/, '');
}

function retryAfterMs(response) {
  const header = response.headers?.get?.('retry-after')
    ?? response.headers?.get?.('x-ratelimit-reset-after');
  const seconds = Number.parseFloat(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(5000, Math.ceil(seconds * 1000));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainResponse(response) {
  if (typeof response.arrayBuffer !== 'function') return;
  try {
    await response.arrayBuffer();
  } catch {
    // The response body is irrelevant once the retry decision is made.
  }
}

export async function executeDiscordWebhook({
  url,
  payload,
  fetchFn = globalThis.fetch,
  timeoutMs = 1800,
  maxAttempts = 2,
  waitFn = wait,
} = {}) {
  if (typeof fetchFn !== 'function') {
    return { state: 'permanent_failure', attempts: 0, reason: 'fetch unavailable' };
  }

  const attemptsLimit = Math.max(1, Math.min(2, Number(maxAttempts) || 1));
  for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
    let response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        state: 'delivery_unknown',
        attempts: attempt,
        reason: error?.name || 'network failure',
      };
    }

    if (response.ok) {
      return { state: 'delivered', attempts: attempt, status: response.status };
    }

    if (attempt < attemptsLimit && RETRYABLE_STATUSES.has(response.status)) {
      await drainResponse(response);
      await waitFn(retryAfterMs(response) ?? 750 * attempt);
      continue;
    }

    await drainResponse(response);
    return {
      state: RETRYABLE_STATUSES.has(response.status) ? 'delivery_unknown' : 'permanent_failure',
      attempts: attempt,
      status: response.status,
    };
  }

  return { state: 'delivery_unknown', attempts: attemptsLimit };
}
