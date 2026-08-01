import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { fetchInputUrl } from './fetch-input.js';

process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
process.env.DISCORD_CLIENT_ID = '12345678901234567';
process.env.DISCORD_GUILD_ID = '22345678901234567';
process.env.OWNER_ID = '32345678901234567';
process.env.DATABASE_PATH = './test/.tmp/runner-modes.db';
process.env.DATABASE_BACKUP_ENABLED = 'true';
process.env.DATABASE_BACKUP_RETENTION = '2';
process.env.RUNNER_TOKEN_SECRET = 'runner-mode-test-secret-123456';

const {
  DiscordApiError,
  QuestCompatibilityError,
  fetchQuests,
  getQuestEngineStatus,
  getUserJobs,
  isFatalAuthError,
  normalizeQuest,
  restoreScheduledRunners,
  selectQuestClaimPlatform,
  shutdownRunners,
  startRunner,
  stopRunner,
  stopScheduledJob,
} = await import('../src/discord-runner.js');
const {
  createScheduledRunner,
  getScheduledRunner,
  listScheduledRunners,
} = await import('../src/scheduled-runner-store.js');
const runCommand = await import('../src/commands/run.js');
const stopCommand = await import('../src/commands/stop.js');
const { backupDatabaseSlot, clearAllDatabaseBackupSlots } = await import('../src/db.js');
const { redactSensitive } = await import('../src/error-reporter.js');
const { runDatabaseBackup } = await import('../src/worker.js');

function mockClient(contents = null) {
  const message = {
    async edit(payload) {
      if (contents) contents.push(payload.content);
      return message;
    },
  };
  return {
    channels: {
      async fetch() {
        return {
          isTextBased: () => true,
          async send(payload) {
            if (contents) contents.push(payload.content);
            return message;
          },
        };
      },
    },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for runner state');
}

function isQuestListUrl(url) {
  const value = fetchInputUrl(url);
  return value.endsWith('/quests/@me') || value.endsWith('/users/@me/quests');
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function startScheduledHeartbeatFailure({
  ownerId,
  accountId,
  username,
  questId,
  questName,
  status,
}) {
  const row = createScheduledRunner({
    ownerId,
    guildId: 'guild',
    channelId: `channel-${ownerId}`,
    accountId,
    username,
    token: `token-${ownerId}`,
    secret: process.env.RUNNER_TOKEN_SECRET,
  });
  globalThis.fetch = async (url) => {
    if (isQuestListUrl(url)) {
      return jsonResponse({ quests: [{
        id: questId,
        config: {
          application: { id: `app-${questId}` },
          messages: { quest_name: questName },
          task_config: { tasks: { PLAY_ON_DESKTOP: { target: 30 } } },
        },
        user_status: {
          enrolled_at: '2026-07-02T00:00:00Z',
          progress: { PLAY_ON_DESKTOP: { value: 0 } },
        },
      }] });
    }
    if (fetchInputUrl(url).includes('/heartbeat')) {
      return jsonResponse({ message: status === 401 ? 'Unauthorized' : 'Forbidden' }, status);
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };

  await startRunner({
    jobKey: `scheduled:${row.id}`,
    ownerId: row.owner_id,
    userToken: `token-${ownerId}`,
    channelId: row.channel_id,
    client: mockClient(),
    mode: 'scheduled',
    scheduleId: row.id,
    accountId: row.account_id,
    username: row.username,
  });
  return row;
}

test.beforeEach(() => {
  global.fetch = async (url) => {
    if (isQuestListUrl(url)) {
      return new Response(JSON.stringify({ quests: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };
});

test('quest parser selects a supported task when an unsupported platform is listed first', () => {
  const quest = normalizeQuest({
    id: 'quest-multi-platform',
    config: {
      messages: { quest_name: 'Multi-platform Quest' },
      task_config_v2: {
        tasks: {
          PLAY_ON_XBOX: { target: 900 },
          WATCH_VIDEO: { target: 60 },
        },
      },
    },
    user_status: {
      progress: { WATCH_VIDEO: { value: 15 } },
    },
  });

  assert.equal(quest.eventName, 'WATCH_VIDEO');
  assert.equal(quest.secondsNeeded, 60);
  assert.equal(quest.progressSecs, 15);
  assert.equal(quest.progress, 25);
  assert.deepEqual(quest.schemaIssues, []);
});

test('quest parser uses task definition type when the map key changes', () => {
  const quest = normalizeQuest({
    id: 'quest-typed-task',
    config: {
      task_config_v2: {
        tasks: {
          desktop_task: { type: 'PLAY_ON_DESKTOP_V2', target: 120 },
        },
      },
      application: { id: 'app-typed-task' },
    },
    user_status: {
      progress: { desktop_task: { value: 30 } },
    },
  });

  assert.equal(quest.eventName, 'PLAY_ON_DESKTOP_V2');
  assert.equal(quest.progressKey, 'desktop_task');
  assert.equal(quest.applicationId, 'app-typed-task');
  assert.equal(quest.progress, 25);
});

test('quest parser recognizes the current event_name task field', () => {
  const quest = normalizeQuest({
    id: 'quest-event-name',
    config: {
      task_config: {
        tasks: {
          opaque_task_key: { event_name: 'WATCH_VIDEO_ON_MOBILE', target: 80 },
        },
      },
    },
    user_status: {
      progress: { opaque_task_key: { value: 20 } },
    },
  });

  assert.equal(quest.eventName, 'WATCH_VIDEO_ON_MOBILE');
  assert.equal(quest.progressKey, 'opaque_task_key');
  assert.equal(quest.progress, 25);
});

test('quest parser recognizes current orb reward claim status', () => {
  const quest = normalizeQuest({
    id: 'quest-orb-claimed',
    config: {
      task_config_v2: {
        tasks: { WATCH_VIDEO: { target: 60 } },
      },
    },
    user_status: {
      completed_at: '2026-07-03T00:00:00Z',
      claimed_at: null,
      orb_quantity_claimed: 500,
      progress: { WATCH_VIDEO: { value: 60 } },
    },
  });

  assert.equal(quest.completed, true);
  assert.equal(quest.claimed, true);
});

test('quest parser preserves reward platforms and selects a safe automatic claim platform', () => {
  const quest = normalizeQuest({
    id: 'quest-platforms',
    config: {
      rewards_config: { platforms: [0, 4] },
      task_config: { tasks: { WATCH_VIDEO: { target: 60 } } },
    },
    user_status: {
      progress: { WATCH_VIDEO: { value: 60 } },
    },
  });

  assert.deepEqual(quest.rewardPlatforms, [0, 4]);
  assert.equal(selectQuestClaimPlatform(quest), 4);
  assert.equal(selectQuestClaimPlatform({ rewardPlatforms: [0] }), 0);
  assert.equal(selectQuestClaimPlatform({ rewardPlatforms: [1] }), 1);
  assert.equal(selectQuestClaimPlatform({ rewardPlatforms: [1, 2] }), null);
  assert.equal(selectQuestClaimPlatform({}), 0);
});

test('malformed Quest API response is reported as incompatible, not as an empty quest list', async () => {
  global.fetch = async () => new Response(
    JSON.stringify({ items: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

  await assert.rejects(
    fetchQuests('token-schema-changed'),
    QuestCompatibilityError,
  );
  const status = getQuestEngineStatus();
  assert.equal(status.state, 'incompatible');
  assert.match(status.lastError, /expected an array/);
});

test('quest fetch falls back to the legacy endpoint when /quests/@me is unavailable', async () => {
  global.fetch = async (url) => {
    const path = fetchInputUrl(url);
    if (path.endsWith('/quests/@me')) {
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.endsWith('/users/@me/quests')) {
      return new Response(JSON.stringify([{
        id: 'legacy-quest',
        config: {
          task_config: { tasks: { WATCH_VIDEO: { target: 60 } } },
        },
        user_status: { progress: { WATCH_VIDEO: { value: 0 } } },
      }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };

  const quests = await fetchQuests('token-legacy-endpoint');
  assert.equal(quests.length, 1);
  assert.equal(getQuestEngineStatus().questListPath, '/users/@me/quests');
});

test('quest fetch checks the alternate endpoint before accepting an empty list', async () => {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(fetchInputUrl(url));
    if (calls.length === 1) {
      return new Response(JSON.stringify({ quests: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ quests: [{
      id: 'quest-from-alternate',
      config: {
        task_config: { tasks: { WATCH_VIDEO: { target: 60 } } },
      },
      user_status: { progress: { WATCH_VIDEO: { value: 0 } } },
    }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const quests = await fetchQuests('token-empty-primary');
  assert.equal(calls.length, 2);
  assert.equal(quests[0].id, 'quest-from-alternate');
});

test('aborted quest fetch does not become a compatibility error', async () => {
  const before = getQuestEngineStatus();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    fetchQuests('token-aborted-fetch', controller.signal),
    (error) => error.name === 'AbortError' && error.message === 'aborted',
  );

  const after = getQuestEngineStatus();
  assert.equal(after.state, before.state);
  assert.equal(after.lastError, before.lastError);
});

test('current Quest API requests use the quest-home referer', async () => {
  let referer = null;
  global.fetch = async (url, options = {}) => {
    if (fetchInputUrl(url).endsWith('/quests/@me')) {
      referer = options.headers?.Referer;
      return new Response(JSON.stringify({ quests: [{
        id: 'referer-quest',
        config: { task_config: { tasks: { WATCH_VIDEO: { target: 1 } } } },
        user_status: { progress: { WATCH_VIDEO: { value: 0 } } },
      }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };

  const quests = await fetchQuests('token-quest-referer');
  assert.equal(quests.length, 1);
  assert.equal(referer, 'https://discord.com/quest-home');
});

test('quest enrollment cooldown is preserved and excludes unaccepted quests from runnable count', async () => {
  const blockedUntil = new Date(Date.now() + 60_000).toISOString();
  global.fetch = async (url) => {
    if (fetchInputUrl(url).endsWith('/quests/@me')) {
      return new Response(JSON.stringify({
        quests: [{
          id: 'cooldown-quest',
          config: { task_config: { tasks: { WATCH_VIDEO: { target: 60 } } } },
          user_status: null,
        }],
        excluded_quests: [{ id: 'excluded-quest' }],
        quest_enrollment_blocked_until: blockedUntil,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };

  const [quest] = await fetchQuests('token-enrollment-cooldown');
  const status = getQuestEngineStatus();
  assert.equal(quest.enrollmentBlockedUntil, blockedUntil);
  assert.equal(status.enrollmentBlockedUntil, blockedUntil);
  assert.equal(status.excludedCount, 1);
  assert.equal(status.supportedCount, 0);
});

test('runner records completion and claim only after Discord returns completed_at and claimed_at', async () => {
  let completed = false;
  let claimed = false;
  let claimBody = null;
  global.fetch = async (url, options = {}) => {
    const path = fetchInputUrl(url);
    if (isQuestListUrl(path)) {
      return new Response(JSON.stringify({ quests: [{
        id: 'quest-server-proof',
        config: {
          messages: { quest_name: 'Server Proof Quest' },
          rewards_config: { platforms: [4] },
          task_config: { tasks: { WATCH_VIDEO: { target: 1 } } },
        },
        user_status: {
          enrolled_at: '2026-07-03T00:00:00Z',
          completed_at: completed ? '2026-07-03T00:01:00Z' : null,
          claimed_at: claimed ? '2026-07-03T00:02:00Z' : null,
          progress: { WATCH_VIDEO: { value: completed ? 1 : 0 } },
        },
      }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.endsWith('/video-progress')) {
      const body = JSON.parse(options.body);
      if (body.timestamp >= 1) completed = true;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.endsWith('/claim-reward')) {
      claimBody = JSON.parse(options.body);
      claimed = true;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };

  await startRunner({
    jobKey: 'scheduled:server-proof',
    ownerId: 'owner-server-proof',
    userToken: 'token-server-proof',
    channelId: 'channel-server-proof',
    client: mockClient(),
    mode: 'scheduled',
    accountId: 'account-server-proof',
    username: 'server-proof-user',
    heartbeatInterval: 1,
  });

  await waitFor(() => Boolean(getQuestEngineStatus().lastVerifiedClaimAt), 3000);
  const status = getQuestEngineStatus();
  assert.ok(status.lastVerifiedCompletionAt);
  assert.ok(status.lastVerifiedClaimAt);
  assert.equal(completed, true);
  assert.equal(claimed, true);
  assert.deepEqual(claimBody, { location: 11, platform: 4 });
  assert.equal(stopRunner('owner-server-proof', { mode: 'scheduled' }), true);
});

test('one-shot runner rescans after each quest and reports the requested flow in order', async () => {
  const states = new Map([
    ['quest-a', { completed: false, claimed: false }],
    ['quest-b', { completed: false, claimed: false }],
  ]);
  const contents = [];

  const payload = () => ({
    quests: [...states.entries()].map(([id, state]) => ({
      id,
      config: {
        messages: { quest_name: id === 'quest-a' ? 'Quest A' : 'Quest B' },
        task_config: { tasks: { WATCH_VIDEO: { target: 1 } } },
      },
      user_status: {
        enrolled_at: '2026-07-03T00:00:00Z',
        completed_at: state.completed ? '2026-07-03T00:01:00Z' : null,
        claimed_at: state.claimed ? '2026-07-03T00:02:00Z' : null,
        progress: { WATCH_VIDEO: { value: state.completed ? 1 : 0 } },
      },
    })),
  });

  global.fetch = async (url, options = {}) => {
    const path = fetchInputUrl(url);
    if (isQuestListUrl(path)) {
      return new Response(JSON.stringify(payload()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const questId = path.includes('quest-a') ? 'quest-a' : 'quest-b';
    if (path.endsWith('/video-progress')) {
      states.get(questId).completed = JSON.parse(options.body).timestamp >= 1;
      return new Response(JSON.stringify({ completed_at: new Date().toISOString() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.endsWith('/claim-reward')) {
      states.get(questId).claimed = true;
      return new Response(JSON.stringify({ claimed_at: new Date().toISOString() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };

  await startRunner({
    jobKey: 'oneshot:multi-quest-proof',
    ownerId: 'owner-multi-quest-proof',
    userToken: 'token-multi-quest-proof',
    channelId: 'channel-multi-quest-proof',
    client: mockClient(contents),
    mode: 'oneshot',
    accountId: 'account-multi-quest-proof',
    username: 'multi-quest-user',
  });

  await waitFor(() => getUserJobs('owner-multi-quest-proof').length === 0, 7000);
  const finalStatus = contents.at(-1);
  const allStatuses = contents.join('\n');
  const expectedFlow = [
    '✅ LOGIN : multi-quest-user',
    '🔎 multi-quest-user: พบ 2 QUESTS',
    '🎉 multi-quest-user: ทำสำเร็จ 0 QUESTS',
    '⏭️ กำลังเตรียมทำ Quest A',
    '▶️ กำลังทำ Quest A',
    '⌛ Quest A 0%',
    '⌛ Quest A 25%',
    '⌛ Quest A 50%',
    '⌛ Quest A 75%',
    '⌛ Quest A 100%',
    '🎉 multi-quest-user: ทำสำเร็จ 1 QUESTS',
    '🧹 QUEST ACTIVITY CLEARED',
    '⏭️ กำลังเตรียมทำ Quest B',
    '▶️ กำลังทำ Quest B',
    '⌛ Quest B 0%',
    '⌛ Quest B 25%',
    '⌛ Quest B 50%',
    '⌛ Quest B 75%',
    '⌛ Quest B 100%',
    '🎉 multi-quest-user: ทำสำเร็จ 2 QUESTS',
    '🎉 บอทได้เข้าไปทำ Quest และรับรางวัลทั้งหมดเสร็จสิ้นแล้ว',
    '🔒 LOGOUT : multi-quest-user',
  ];
  let previousIndex = -1;
  for (const line of expectedFlow) {
    const index = allStatuses.indexOf(line, previousIndex + 1);
    assert.ok(index > previousIndex, `${line} must appear in order`);
    previousIndex = index;
  }
  assert.doesNotMatch(finalStatus, /CLAIM|DONE|ข้าม|เควสที่ยังไม่เสร็จทั้งหมด/);
  assert.equal(finalStatus.match(/🔒 LOGOUT/g)?.length, 1);
  assert.equal(states.get('quest-a').claimed, true);
  assert.equal(states.get('quest-b').claimed, true);
});

test('runner counts only runnable quests and hides expired, future, blocked, unsupported and completed quests', async () => {
  const contents = [];
  let runnableCompleted = false;
  let runnableClaimed = false;
  const makeQuest = ({
    id,
    name,
    event = 'WATCH_VIDEO',
    startsAt = null,
    expiresAt = null,
    enrolled = true,
    completed = false,
    claimed = false,
  }) => ({
    id,
    config: {
      messages: { quest_name: name },
      starts_at: startsAt,
      expires_at: expiresAt,
      task_config: { tasks: { [event]: { target: 1 } } },
    },
    user_status: {
      enrolled_at: enrolled ? '2026-07-03T00:00:00Z' : null,
      completed_at: completed ? '2026-07-03T00:01:00Z' : null,
      claimed_at: claimed ? '2026-07-03T00:02:00Z' : null,
      progress: { [event]: { value: completed ? 1 : 0 } },
    },
  });
  const payload = () => ({
    quest_enrollment_blocked_until: new Date(Date.now() + 60_000).toISOString(),
    quests: [
      makeQuest({
        id: 'runnable',
        name: 'Runnable Quest',
        completed: runnableCompleted,
        claimed: runnableClaimed,
      }),
      makeQuest({
        id: 'expired',
        name: 'Expired Hidden Quest',
        expiresAt: '2020-01-01T00:00:00Z',
      }),
      makeQuest({
        id: 'future',
        name: 'Future Hidden Quest',
        startsAt: '2099-01-01T00:00:00Z',
      }),
      makeQuest({
        id: 'blocked',
        name: 'Blocked Hidden Quest',
        enrolled: false,
      }),
      makeQuest({
        id: 'unsupported',
        name: 'Unsupported Hidden Quest',
        event: 'PLAY_ON_XBOX',
      }),
      makeQuest({
        id: 'completed',
        name: 'Completed Hidden Quest',
        completed: true,
        claimed: true,
      }),
    ],
  });

  global.fetch = async (url, options = {}) => {
    const path = fetchInputUrl(url);
    if (isQuestListUrl(path)) {
      return new Response(JSON.stringify(payload()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.endsWith('/video-progress')) {
      runnableCompleted = JSON.parse(options.body).timestamp >= 1;
      return jsonResponse({ ok: true });
    }
    if (path.endsWith('/claim-reward')) {
      runnableClaimed = true;
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };

  await startRunner({
    jobKey: 'oneshot:filtered-quests',
    ownerId: 'owner-filtered-quests',
    userToken: 'token-filtered-quests',
    channelId: 'channel-filtered-quests',
    client: mockClient(contents),
    mode: 'oneshot',
    accountId: 'account-filtered-quests',
    username: 'filtered-user',
  });

  await waitFor(() => getUserJobs('owner-filtered-quests').length === 0, 4000);
  const finalStatus = contents.at(-1);
  assert.match(finalStatus, /🔎 filtered-user: พบ 1 QUESTS/);
  assert.match(finalStatus, /กำลังเตรียมทำ Runnable Quest/);
  assert.doesNotMatch(
    finalStatus,
    /Expired Hidden|Future Hidden|Blocked Hidden|Unsupported Hidden|Completed Hidden/,
  );
  assert.doesNotMatch(finalStatus, /ข้าม|เควสที่ยังไม่เสร็จทั้งหมด/);
});

test('runner reports existing Discord progress before the remaining checkpoints', async () => {
  const contents = [];
  let completed = false;
  let claimed = false;
  global.fetch = async (url, options = {}) => {
    const path = fetchInputUrl(url);
    if (isQuestListUrl(path)) {
      return new Response(JSON.stringify({ quests: [{
        id: 'partial-progress',
        config: {
          messages: { quest_name: 'Partial Quest' },
          task_config: { tasks: { WATCH_VIDEO: { target: 10 } } },
        },
        user_status: {
          enrolled_at: '2026-07-03T00:00:00Z',
          completed_at: completed ? '2026-07-03T00:01:00Z' : null,
          claimed_at: claimed ? '2026-07-03T00:02:00Z' : null,
          progress: { WATCH_VIDEO: { value: completed ? 10 : 4 } },
        },
      }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.endsWith('/video-progress')) {
      completed = JSON.parse(options.body).timestamp >= 10;
      return jsonResponse({ ok: true });
    }
    if (path.endsWith('/claim-reward')) {
      claimed = true;
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };

  await startRunner({
    jobKey: 'oneshot:partial-progress',
    ownerId: 'owner-partial-progress',
    userToken: 'token-partial-progress',
    channelId: 'channel-partial-progress',
    client: mockClient(contents),
    mode: 'oneshot',
    accountId: 'account-partial-progress',
    username: 'partial-user',
  });

  await waitFor(() => getUserJobs('owner-partial-progress').length === 0, 4000);
  const finalStatus = contents.at(-1);
  const progressLines = [40, 50, 75, 100].map(
    (percent) => `⌛ Partial Quest ${percent}%`,
  );
  let previousIndex = -1;
  for (const line of progressLines) {
    const index = finalStatus.indexOf(line);
    assert.ok(index > previousIndex, `${line} must appear in order`);
    previousIndex = index;
  }
  assert.doesNotMatch(finalStatus, /Partial Quest 0%|Partial Quest 25%/);
});

test('claim failures stay out of the channel while one-shot still logs out', async () => {
  const contents = [];
  global.fetch = async (url) => {
    const path = fetchInputUrl(url);
    if (isQuestListUrl(path)) {
      return new Response(JSON.stringify({ quests: [{
        id: 'claim-failure',
        config: {
          messages: { quest_name: 'Silent Claim Quest' },
          task_config: { tasks: { WATCH_VIDEO: { target: 1 } } },
        },
        user_status: {
          enrolled_at: '2026-07-03T00:00:00Z',
          completed_at: '2026-07-03T00:01:00Z',
          claimed_at: null,
          progress: { WATCH_VIDEO: { value: 1 } },
        },
      }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.endsWith('/claim-reward')) {
      return jsonResponse({ message: 'Forbidden' }, 403);
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };

  await startRunner({
    jobKey: 'oneshot:silent-claim-failure',
    ownerId: 'owner-silent-claim-failure',
    userToken: 'token-silent-claim-failure',
    channelId: 'channel-silent-claim-failure',
    client: mockClient(contents),
    mode: 'oneshot',
    accountId: 'account-silent-claim-failure',
    username: 'silent-user',
  });

  await waitFor(() => getUserJobs('owner-silent-claim-failure').length === 0);
  const finalStatus = contents.at(-1);
  assert.doesNotMatch(finalStatus, /🎁|claim failed|claim error|CLAIMED|ส่ง Claim|Silent Claim Quest/i);
  assert.match(finalStatus, /🔎 silent-user: พบ 0 QUESTS/);
  assert.equal(finalStatus.match(/🔒 LOGOUT/g)?.length, 1);
});

test('completed quests outside the locked manifest are not claimed while session quests continue', async () => {
  const contents = [];
  const states = new Map([
    ['manual-claim', { completed: true, claimed: false }],
    ['next-quest-a', { completed: false, claimed: false }],
    ['next-quest-b', { completed: false, claimed: false }],
  ]);
  let blockedClaimAttempts = 0;

  const payload = () => ({
    quests: [...states.entries()].map(([id, state]) => ({
      id,
      config: {
        messages: { quest_name: id },
        rewards_config: { platforms: [0] },
        task_config: { tasks: { WATCH_VIDEO: { target: 1 } } },
      },
      user_status: {
        enrolled_at: '2026-07-03T00:00:00Z',
        completed_at: state.completed ? '2026-07-03T00:01:00Z' : null,
        claimed_at: state.claimed ? '2026-07-03T00:02:00Z' : null,
        progress: { WATCH_VIDEO: { value: state.completed ? 1 : 0 } },
      },
    })),
  });

  global.fetch = async (url, options = {}) => {
    const path = fetchInputUrl(url);
    if (isQuestListUrl(path)) return jsonResponse(payload());
    const questId = [...states.keys()].find((id) => path.includes(id));
    if (path.endsWith('/video-progress')) {
      states.get(questId).completed = JSON.parse(options.body).timestamp >= 1;
      return jsonResponse({ ok: true });
    }
    if (path.endsWith('/claim-reward')) {
      if (questId === 'manual-claim') {
        blockedClaimAttempts++;
        return jsonResponse({
          captcha_key: ['captcha-required'],
          captcha_sitekey: 'test-site-key',
        }, 400);
      }
      states.get(questId).claimed = true;
      return jsonResponse({ claimed_at: new Date().toISOString() });
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };

  await startRunner({
    jobKey: 'oneshot:claim-cooldown',
    ownerId: 'owner-claim-cooldown',
    userToken: 'token-claim-cooldown',
    channelId: 'channel-claim-cooldown',
    client: mockClient(contents),
    mode: 'oneshot',
    accountId: 'account-claim-cooldown',
    username: 'claim-cooldown-user',
  });

  await waitFor(() => getUserJobs('owner-claim-cooldown').length === 0, 5000);
  assert.equal(blockedClaimAttempts, 0);
  assert.equal(states.get('next-quest-a').claimed, true);
  assert.equal(states.get('next-quest-b').claimed, true);
  assert.doesNotMatch(contents.join('\n'), /captcha|claim failed|CLAIMED|ส่ง Claim/i);
});

test('PLAY_ON_DESKTOP switches to application_id when the first heartbeat payload makes no progress', async () => {
  let progress = 0;
  let completed = false;
  let claimed = false;
  const heartbeatBodies = [];

  global.fetch = async (url, options = {}) => {
    const path = fetchInputUrl(url);
    if (isQuestListUrl(path)) {
      return new Response(JSON.stringify({ quests: [{
        id: 'quest-play',
        config: {
          application: { id: 'application-play' },
          messages: { quest_name: 'Play Quest' },
          task_config_v2: {
            tasks: {
              play_task: { type: 'PLAY_ON_DESKTOP', target: 1 },
            },
          },
        },
        user_status: {
          enrolled_at: '2026-07-03T00:00:00Z',
          completed_at: completed ? '2026-07-03T00:01:00Z' : null,
          claimed_at: claimed ? '2026-07-03T00:02:00Z' : null,
          progress: { play_task: { value: progress } },
        },
      }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.endsWith('/heartbeat')) {
      const body = JSON.parse(options.body);
      heartbeatBodies.push(body);
      if (body.terminal) completed = true;
      else if (body.application_id) progress = 1;
      return new Response(JSON.stringify({
        completed_at: completed ? new Date().toISOString() : null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.endsWith('/claim-reward')) {
      claimed = true;
      return new Response(JSON.stringify({ claimed_at: new Date().toISOString() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };

  await startRunner({
    jobKey: 'oneshot:play-proof',
    ownerId: 'owner-play-proof',
    userToken: 'token-play-proof',
    channelId: 'channel-play-proof',
    client: mockClient(),
    mode: 'oneshot',
    accountId: 'account-play-proof',
    username: 'play-proof-user',
    heartbeatInterval: 1,
  });

  await waitFor(() => getUserJobs('owner-play-proof').length === 0, 6000);
  assert.deepEqual(heartbeatBodies, [
    { stream_key: 'call:quest-play:1', terminal: false },
    { application_id: 'application-play', terminal: false },
    { application_id: 'application-play', terminal: true },
  ]);
  assert.equal(completed, true);
  assert.equal(claimed, true);
});

test('one-shot runner exits after the first empty quest scan and logs out exactly once', async () => {
  const contents = [];
  await startRunner({
    jobKey: 'oneshot:test',
    ownerId: 'owner-one',
    userToken: 'token-one',
    channelId: 'channel-one',
    client: mockClient(contents),
    mode: 'oneshot',
    accountId: 'account-one',
    username: 'one-shot-user',
  });

  await waitFor(() => getUserJobs('owner-one').length === 0);
  const finalStatus = contents.at(-1);
  assert.match(finalStatus, /🔎 one-shot-user: พบ 0 QUESTS/);
  assert.equal(finalStatus.match(/🔒 LOGOUT : one-shot-user/g)?.length, 1);
});

test('scheduled runner stays active after an empty scan until explicitly stopped', async () => {
  const contents = [];
  const row = createScheduledRunner({
    ownerId: 'owner-scheduled',
    guildId: 'guild',
    channelId: 'channel-scheduled',
    accountId: 'account-scheduled',
    username: 'scheduled-user',
    token: 'token-scheduled',
    secret: process.env.RUNNER_TOKEN_SECRET,
  });

  await startRunner({
    jobKey: `scheduled:${row.id}`,
    ownerId: row.owner_id,
    userToken: 'token-scheduled',
    channelId: row.channel_id,
    client: mockClient(contents),
    mode: 'scheduled',
    scheduleId: row.id,
    accountId: row.account_id,
    username: row.username,
  });

  await waitFor(() => Boolean(getUserJobs('owner-scheduled')[0]?.nextCheckAt));
  await waitFor(
    () => contents.some((content) => content.includes('🔎 scheduled-user: พบ 0 QUESTS')),
    3000,
  );
  assert.equal(getUserJobs('owner-scheduled').length, 1);
  assert.ok(getScheduledRunner(row.id)?.next_check_at);
  assert.match(contents.join('\n'), /🔎 scheduled-user: พบ 0 QUESTS/);
  assert.doesNotMatch(contents.join('\n'), /🔒 LOGOUT/);

  assert.equal(stopScheduledJob('owner-scheduled', row.id), true);
  assert.equal(getUserJobs('owner-scheduled').length, 0);
  assert.equal(getScheduledRunner(row.id), null);
});

test('stopping a one-shot runner reports logout exactly once', async () => {
  const contents = [];
  await startRunner({
    jobKey: 'oneshot:user-stop',
    ownerId: 'owner-user-stop',
    userToken: 'token-user-stop',
    channelId: 'channel-user-stop',
    client: mockClient(contents),
    mode: 'oneshot',
    accountId: 'account-user-stop',
    username: 'user-stop-account',
  });

  assert.equal(stopRunner('owner-user-stop', { mode: 'oneshot' }), true);
  await waitFor(() => contents.some((content) => content.includes('🔒 LOGOUT : user-stop-account')));
  const finalStatus = contents.at(-1);
  assert.equal(finalStatus.match(/🔒 LOGOUT : user-stop-account/g)?.length, 1);
  assert.doesNotMatch(finalStatus, /STOPPED BY USER/);
});

test('one-shot runner logs out once after three attempts make no progress', async () => {
  const contents = [];
  let enrollAttempts = 0;
  global.fetch = async (url) => {
    const path = fetchInputUrl(url);
    if (isQuestListUrl(path)) {
      return new Response(JSON.stringify({ quests: [{
        id: 'no-progress',
        config: {
          messages: { quest_name: 'No Progress Quest' },
          task_config: { tasks: { WATCH_VIDEO: { target: 60 } } },
        },
        user_status: null,
      }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.endsWith('/enroll')) {
      enrollAttempts++;
      return jsonResponse({ message: 'Forbidden' }, 403);
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };

  await startRunner({
    jobKey: 'oneshot:no-progress',
    ownerId: 'owner-no-progress',
    userToken: 'token-no-progress',
    channelId: 'channel-no-progress',
    client: mockClient(contents),
    mode: 'oneshot',
    accountId: 'account-no-progress',
    username: 'no-progress-user',
  });

  await waitFor(() => getUserJobs('owner-no-progress').length === 0);
  const finalStatus = contents.at(-1);
  assert.equal(enrollAttempts, 1);
  assert.equal(finalStatus.match(/🔒 LOGOUT : no-progress-user/g)?.length, 1);
});

test('one-shot runner logs out once when the Quest API fails', async () => {
  const contents = [];
  global.fetch = async () => new Response(
    JSON.stringify({ unexpected: true }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

  await startRunner({
    jobKey: 'oneshot:quest-api-error',
    ownerId: 'owner-quest-api-error',
    userToken: 'token-quest-api-error',
    channelId: 'channel-quest-api-error',
    client: mockClient(contents),
    mode: 'oneshot',
    accountId: 'account-quest-api-error',
    username: 'quest-api-error-user',
  });

  await waitFor(() => getUserJobs('owner-quest-api-error').length === 0);
  const finalStatus = contents.at(-1);
  assert.match(finalStatus, /❌ quest-api-error-user:/);
  assert.equal(finalStatus.match(/🔒 LOGOUT : quest-api-error-user/g)?.length, 1);
});

test('saved scheduled runners are restored with their persisted next check', async () => {
  const nextCheckAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const row = createScheduledRunner({
    ownerId: 'owner-restored',
    guildId: 'guild',
    channelId: 'channel-restored',
    accountId: 'account-restored',
    username: 'restored-user',
    token: 'token-restored',
    secret: process.env.RUNNER_TOKEN_SECRET,
    nextCheckAt,
  });

  const result = await restoreScheduledRunners(mockClient());
  assert.equal(result.failed, 0);
  assert.equal(result.restored, 1);
  assert.equal(getUserJobs('owner-restored')[0]?.nextCheckAt, nextCheckAt);

  stopScheduledJob('owner-restored', row.id);
});

test('/run replies publicly and starts a persisted scheduled runner', async () => {
  let deferOptions = null;
  let replyContent = null;
  global.fetch = async (url) => {
    if (fetchInputUrl(url).endsWith('/users/@me')) {
      return new Response(JSON.stringify({ id: 'account-command', username: 'command-user' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (isQuestListUrl(url)) {
      return new Response(JSON.stringify({ quests: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${fetchInputUrl(url)}`);
  };

  await runCommand.handleModal({
    customId: 'run_modal:scheduled:channel-command',
    fields: { getTextInputValue: () => 'token-command' },
    user: { id: 'owner-command' },
    member: { permissions: { has: () => true } },
    guildId: 'guild',
    client: mockClient(),
    async deferReply(options) {
      deferOptions = options;
    },
    async editReply(content) {
      replyContent = content;
    },
  });

  assert.deepEqual(deferOptions, {});
  assert.match(replyContent, /AUTO DAILY QUEST/);
  await waitFor(() => Boolean(getUserJobs('owner-command')[0]?.nextCheckAt));

  const [row] = listScheduledRunners('owner-command');
  assert.ok(row);
  stopScheduledJob('owner-command', row.id);
});

test('/stop is ephemeral and selected rows are removed', async () => {
  const row = createScheduledRunner({
    ownerId: 'owner-stop-command',
    guildId: 'guild',
    channelId: 'channel-stop',
    accountId: 'account-stop',
    username: 'stop-user',
    token: 'token-stop',
    secret: process.env.RUNNER_TOKEN_SECRET,
  });
  let replyPayload = null;
  await stopCommand.execute({
    user: { id: 'owner-stop-command' },
    async reply(payload) {
      replyPayload = payload;
    },
  });

  assert.equal(replyPayload.flags, 64);
  assert.equal(replyPayload.components[0].components[0].data.custom_id, 'runner-stop:select');

  await stopCommand.handleSelect({
    user: { id: 'owner-stop-command' },
    values: [String(row.id)],
    async update() {},
  });
  assert.equal(getScheduledRunner(row.id), null);
});

test('401 disables a scheduled runner and removes its saved token', async () => {
  const row = createScheduledRunner({
    ownerId: 'owner-invalid-token',
    guildId: 'guild',
    channelId: 'channel-invalid',
    accountId: 'account-invalid',
    username: 'invalid-user',
    token: 'token-invalid',
    secret: process.env.RUNNER_TOKEN_SECRET,
  });
  global.fetch = async () => new Response(
    JSON.stringify({ message: '401: Unauthorized', code: 0 }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );

  await startRunner({
    jobKey: `scheduled:${row.id}`,
    ownerId: row.owner_id,
    userToken: 'token-invalid',
    channelId: row.channel_id,
    client: mockClient(),
    mode: 'scheduled',
    scheduleId: row.id,
    accountId: row.account_id,
    username: row.username,
  });

  await waitFor(() => getUserJobs(row.owner_id).length === 0);
  assert.equal(getScheduledRunner(row.id), null);
});

test('403 is fatal only for identity and quest-list endpoints', () => {
  assert.equal(
    isFatalAuthError(new DiscordApiError(403, '/quests/@me', {})),
    true,
  );
  assert.equal(
    isFatalAuthError(new DiscordApiError(403, '/quests/123/heartbeat', {})),
    false,
  );
});

test('a 401 from heartbeat is propagated and disables the scheduled runner', async () => {
  const row = await startScheduledHeartbeatFailure({
    ownerId: 'owner-heartbeat-unauthorized',
    accountId: 'account-heartbeat-unauthorized',
    username: 'heartbeat-unauthorized-user',
    questId: 'quest-401',
    questName: 'Unauthorized Quest',
    status: 401,
  });

  await waitFor(() => getUserJobs(row.owner_id).length === 0);
  assert.equal(getScheduledRunner(row.id), null);
});

test('an action-specific 403 stops that attempt without deleting the scheduled runner', async () => {
  const row = await startScheduledHeartbeatFailure({
    ownerId: 'owner-action-forbidden',
    accountId: 'account-action-forbidden',
    username: 'action-forbidden-user',
    questId: 'quest-403',
    questName: 'Forbidden Quest',
    status: 403,
  });

  await waitFor(() => Boolean(getUserJobs(row.owner_id)[0]?.nextCheckAt));
  assert.ok(getScheduledRunner(row.id));
  stopScheduledJob(row.owner_id, row.id);
});

test('graceful runner shutdown preserves scheduled rows for restart recovery', async () => {
  const row = createScheduledRunner({
    ownerId: 'owner-shutdown',
    guildId: 'guild',
    channelId: 'channel-shutdown',
    accountId: 'account-shutdown',
    username: 'shutdown-user',
    token: 'token-shutdown',
    secret: process.env.RUNNER_TOKEN_SECRET,
    nextCheckAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  await startRunner({
    jobKey: `scheduled:${row.id}`,
    ownerId: row.owner_id,
    userToken: 'token-shutdown',
    channelId: row.channel_id,
    client: mockClient(),
    mode: 'scheduled',
    scheduleId: row.id,
    accountId: row.account_id,
    username: row.username,
    initialNextCheckAt: row.next_check_at,
  });

  await shutdownRunners();
  assert.equal(getUserJobs(row.owner_id).length, 0);
  assert.ok(getScheduledRunner(row.id));
  stopScheduledJob(row.owner_id, row.id);
});

test('critical error redaction removes token-like secrets', () => {
  const safe = redactSensitive('Authorization: abc.def.abcdefghijklmnopqrstuvwxyz token=plain-secret');
  assert.doesNotMatch(safe, /abcdefghijklmnopqrstuvwxyz|plain-secret/);
  assert.match(safe, /REDACTED/);
});

test('database backup slot creates a readable SQLite snapshot', async () => {
  await clearAllDatabaseBackupSlots();
  const destination = await backupDatabaseSlot(0);
  const stat = await fs.stat(destination);
  assert.ok(stat.size > 0);
  assert.equal(destination, './data/backups/questbot-slot-1.db');
  await clearAllDatabaseBackupSlots();
});

test('scheduled database backups rotate through the configured fixed slots', async () => {
  await clearAllDatabaseBackupSlots();
  const first = await runDatabaseBackup(new Date('2026-07-01T03:00:00Z'));
  const second = await runDatabaseBackup(new Date('2026-07-02T03:00:00Z'));
  const third = await runDatabaseBackup(new Date('2026-07-03T03:00:00Z'));

  assert.notEqual(first, second);
  assert.equal(first, third);
  for (const destination of new Set([first, second])) {
    const stat = await fs.stat(destination);
    assert.ok(stat.size > 0);
  }
  await clearAllDatabaseBackupSlots();
});

test('run modal rechecks permissions when the modal is submitted', async () => {
  let runReply;
  await runCommand.handleModal({
    customId: 'run_modal:scheduled:channel',
    user: { id: 'owner-no-role' },
    member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
    async reply(payload) {
      runReply = payload;
    },
  });
  assert.match(runReply.content, /สิทธิ์ของคุณเปลี่ยนไป/);
});


test('one-shot locks its quest manifest when new quests appear mid-session', async () => {
  const contents = [];
  const requests = [];
  const states = new Map([
    ['locked-a', { completed: false, claimed: false }],
    ['locked-b', { completed: false, claimed: false }],
    ['late-c', { completed: false, claimed: false }],
  ]);
  let includeLateQuest = false;

  const payload = () => ({
    quests: [...states.entries()]
      .filter(([id]) => id !== 'late-c' || includeLateQuest)
      .map(([id, state]) => ({
        id,
        config: {
          messages: { quest_name: id },
          task_config: { tasks: { WATCH_VIDEO: { target: 1 } } },
        },
        user_status: {
          enrolled_at: '2026-07-03T00:00:00Z',
          completed_at: state.completed ? '2026-07-03T00:01:00Z' : null,
          claimed_at: state.claimed ? '2026-07-03T00:02:00Z' : null,
          progress: { WATCH_VIDEO: { value: state.completed ? 1 : 0 } },
        },
      })),
  });

  global.fetch = async (url, options = {}) => {
    const path = fetchInputUrl(url);
    if (isQuestListUrl(path)) return jsonResponse(payload());
    const questId = [...states.keys()].find((id) => path.includes(id));
    if (path.endsWith('/video-progress')) {
      requests.push(`progress:${questId}`);
      states.get(questId).completed = JSON.parse(options.body).timestamp >= 1;
      if (questId === 'locked-a') includeLateQuest = true;
      return jsonResponse({ completed_at: new Date().toISOString() });
    }
    if (path.endsWith('/claim-reward')) {
      requests.push(`claim:${questId}`);
      states.get(questId).claimed = true;
      return jsonResponse({ claimed_at: new Date().toISOString() });
    }
    throw new Error(`Unexpected fetch: ${path}`);
  };

  await startRunner({
    jobKey: 'oneshot:locked-manifest',
    ownerId: 'owner-locked-manifest',
    userToken: 'token-locked-manifest',
    channelId: 'channel-locked-manifest',
    client: mockClient(contents),
    mode: 'oneshot',
    accountId: 'account-locked-manifest',
    username: 'locked-user',
  });

  await waitFor(() => getUserJobs('owner-locked-manifest').length === 0, 7000);
  const finalStatus = contents.at(-1);
  assert.deepEqual(requests.filter((item) => item.startsWith('progress:')), [
    'progress:locked-a',
    'progress:locked-b',
  ]);
  assert.doesNotMatch(requests.join('\n'), /late-c/);
  assert.match(finalStatus, /🔎 locked-user: พบ 2 QUESTS/);
  assert.match(finalStatus, /🎉 locked-user: ทำสำเร็จ 2 QUESTS/);
  assert.doesNotMatch(contents.join('\n'), /late-c/);
});

test('one-shot reports external completion in the quest reason without counting it as bot work', async () => {
  const contents = [];
  const requests = [];
  const states = new Map([
    ['bot-a', { completed: false, claimed: false }],
    ['external-b', { completed: false, claimed: false }],
  ]);

  const payload = () => ({
    quests: [...states.entries()].map(([id, state]) => ({
      id,
      config: {
        messages: { quest_name: id === 'bot-a' ? 'Bot Quest A' : 'External Quest B' },
        task_config: { tasks: { WATCH_VIDEO: { target: 1 } } },
      },
      user_status: {
        enrolled_at: '2026-07-03T00:00:00Z',
        completed_at: state.completed ? '2026-07-03T00:01:00Z' : null,
        claimed_at: state.claimed ? '2026-07-03T00:02:00Z' : null,
        progress: { WATCH_VIDEO: { value: state.completed ? 1 : 0 } },
      },
    })),
  });

  global.fetch = async (url, options = {}) => {
    const path = fetchInputUrl(url);
    if (isQuestListUrl(path)) return jsonResponse(payload());
    const questId = [...states.keys()].find((id) => path.includes(id));
    if (path.endsWith('/video-progress')) {
      requests.push(`progress:${questId}`);
      states.get(questId).completed = JSON.parse(options.body).timestamp >= 1;
      if (questId === 'bot-a') states.get('external-b').completed = true;
      return jsonResponse({ completed_at: new Date().toISOString() });
    }
    if (path.endsWith('/claim-reward')) {
      requests.push(`claim:${questId}`);
      states.get(questId).claimed = true;
      return jsonResponse({ claimed_at: new Date().toISOString() });
    }
    throw new Error(`Unexpected fetch: ${path}`);
  };

  await startRunner({
    jobKey: 'oneshot:external-completion',
    ownerId: 'owner-external-completion',
    userToken: 'token-external-completion',
    channelId: 'channel-external-completion',
    client: mockClient(contents),
    mode: 'oneshot',
    accountId: 'account-external-completion',
    username: 'external-user',
  });

  await waitFor(() => getUserJobs('owner-external-completion').length === 0, 5000);
  const finalStatus = contents.at(-1);
  assert.deepEqual(requests, ['progress:bot-a', 'claim:bot-a', 'claim:external-b']);
  assert.equal(states.get('external-b').claimed, true);
  assert.match(finalStatus, /🔎 external-user: พบ 2 QUESTS/);
  assert.match(finalStatus, /🎉 external-user: ทำสำเร็จ 1 QUESTS/);
  assert.match(finalStatus, /1\. External Quest B/);
  assert.match(finalStatus, /└ Quest เสร็จจากภายนอก จึงไม่นับเป็น Quest ที่บอททำ/);
  assert.doesNotMatch(finalStatus, /ℹ️ มี Quest ที่เสร็จจากภายนอก/);
  assert.equal(finalStatus.match(/🔒 LOGOUT/g)?.length, 1);
});
