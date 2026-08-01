import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { redactSensitive } from '../error-reporter.js';
import { isManager } from '../permissions.js';
import {
  listActiveProcessRoles,
  listActiveWorkerHolders,
} from '../process-topology.js';
import { getDiscordApiRuntimeStatus } from '../quest/discord-api-runtime.js';
import {
  getQuestEngineStatus,
  listJobs,
  listQuestEngineStatuses,
} from '../quest/runner-service.js';
import { listRunnerStates, RUNNER_STATE } from '../quest/runner-state-store.js';
import { listScheduledRunnerClaims } from '../quest/scheduled-worker-claims.js';
import { listScheduledRunners } from '../scheduled-runner-store.js';

export const data = new SlashCommandBuilder()
  .setName('api-status')
  .setDescription('เช็กสถานะระบบและ Quest API สำหรับ Manager');

const STATUS_COLORS = Object.freeze({
  error: '#ED4245',
  warning: '#FEE75C',
  healthy: '#57F287',
});

function discordTime(iso) {
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:R>` : 'ยังไม่มี';
}

const stateLabels = {
  unknown: '⚪ ยังไม่มีการตรวจ',
  compatible: '🟢 ใช้งานร่วมกันได้',
  degraded: '🟡 พบ schema/event ใหม่',
  incompatible: '🔴 รูปแบบ API ไม่รองรับ',
  error: '🔴 ติดต่อ API ไม่สำเร็จ',
};

function accountStatusLine(status) {
  const identity = status.username ?? status.accountId ?? status.jobKey ?? status.key;
  return [
    `**${String(identity).slice(0, 80)}** · ${stateLabels[status.state] ?? status.state}`,
    `Quest ${status.questCount} / พร้อมทำ ${status.supportedCount} · ${status.lifecycle}`,
    `ตรวจล่าสุด ${discordTime(status.lastCheckAt)}`,
  ].join('\n');
}

function selectStatusColor(dbOk, state) {
  if (!dbOk || state === 'error' || state === 'incompatible') return STATUS_COLORS.error;
  if (state === 'degraded') return STATUS_COLORS.warning;
  return STATUS_COLORS.healthy;
}

function databaseHealth() {
  const start = Date.now();
  try {
    db.prepare('SELECT 1').get();
    return { dbOk: true, dbError: null, latency: Date.now() - start };
  } catch (error) {
    return {
      dbOk: false,
      dbError: error?.message ?? String(error),
      latency: Date.now() - start,
    };
  }
}

function questDetailLines(aggregate) {
  const details = [
    '**สรุปรวมจากสถานะแยกของทุก Job/Account**',
    `สถานะ: ${stateLabels[aggregate.state] ?? aggregate.state}`,
    `บัญชีที่มีสถานะ: **${aggregate.accountCount ?? 0}**`,
    `พยายามตรวจล่าสุด: ${discordTime(aggregate.lastCheckAt)}`,
    `สำเร็จล่าสุด: ${discordTime(aggregate.lastSuccessfulCheckAt)}`,
    `พบ ${aggregate.questCount} Quest / พร้อมทำ ${aggregate.supportedCount} / excluded ${aggregate.excludedCount ?? 0}`,
    `Endpoint: \`${aggregate.questListPath ?? 'ยังไม่มี'}\``,
  ];
  if (aggregate.enrollmentBlockedUntil) {
    details.push(`รับ Quest ใหม่ได้: ${discordTime(aggregate.enrollmentBlockedUntil)}`);
  }
  if (aggregate.unknownEvents.length) {
    details.push(`Event ใหม่: \`${aggregate.unknownEvents.join(', ').slice(0, 500)}\``);
  }
  if (aggregate.schemaIssues.length) {
    details.push(`Schema: \`${aggregate.schemaIssues.join('; ').slice(0, 500)}\``);
  }
  return details;
}

function accountDetailText(accountStatuses) {
  return accountStatuses.length
    ? accountStatuses.slice(0, 8).map(accountStatusLine).join('\n\n')
    : 'ยังไม่มีผลตรวจ Quest API ของบัญชีคุณ';
}

function runnerCounts(snapshot) {
  const verifyingStates = new Set([
    RUNNER_STATE.VERIFYING_ENROLLMENT,
    RUNNER_STATE.VERIFYING_PROGRESS,
    RUNNER_STATE.VERIFYING_CLAIM,
  ]);
  return {
    oneShot: snapshot.jobs.filter((job) => job.mode === 'oneshot').length,
    scheduled: snapshot.jobs.filter((job) => job.mode === 'scheduled').length,
    persisted: snapshot.persisted.length,
    durable: snapshot.activeDurable.length,
    recovering: snapshot.activeDurable.filter((row) => row.state === RUNNER_STATE.RECOVERING).length,
    stopping: snapshot.activeDurable.filter((row) => row.state === RUNNER_STATE.STOPPING).length,
    verifying: snapshot.activeDurable.filter((row) => verifyingStates.has(row.state)).length,
  };
}

function topologyField(snapshot) {
  return {
    name: 'Process Topology',
    value: [
      `Process นี้: **${config.processRole.toUpperCase()}**`,
      `Role ที่ทำงาน: **${snapshot.activeRoles.length ? snapshot.activeRoles.join(' + ').toUpperCase() : 'NONE'}**`,
      `Worker processes: **${snapshot.workerHolders.size}**`,
      `Scheduled claims: **${snapshot.activeClaims.length}**`,
      `Worker poll: **${config.workerPollIntervalMs}ms**`,
    ].join('\n'),
    inline: false,
  };
}

function transportField(transport) {
  return {
    name: `Discord HTTP API v${transport.apiVersion}`,
    value: [
      `Runtime: **${transport.installed ? 'ACTIVE' : 'INACTIVE'}**`,
      `Queue: **${transport.rateLimit.queued}** · Active: **${transport.rateLimit.active}**`,
      `429: **${transport.rateLimit.rateLimited}** · Global: **${transport.rateLimit.globalRateLimits}**`,
      `Routes/Scopes: **${transport.rateLimit.knownRoutes ?? 0}/${transport.rateLimit.knownScopes ?? 0}**`,
      `Blocked buckets: **${transport.rateLimit.blockedBuckets}**`,
      `Circuits: **${transport.rateLimit.openCircuits ?? 0} open / ${transport.rateLimit.halfOpenCircuits ?? 0} probe**`,
      `Checkpoint errors: **${transport.rateLimit.checkpointErrors ?? 0}** · Hint errors: **${transport.rateLimit.scheduleHintErrors ?? 0}**`,
    ].join('\n'),
    inline: false,
  };
}

function runnerField(snapshot) {
  const counts = runnerCounts(snapshot);
  return {
    name: 'Runner',
    value: [
      `One-shot ใน Process นี้: **${counts.oneShot}**`,
      `Auto Daily ใน Process นี้: **${counts.scheduled}**`,
      `Auto Daily ที่บันทึก: **${counts.persisted}**`,
      `Durable state ที่ยังทำงาน: **${counts.durable}**`,
      `Recovering: **${counts.recovering}**`,
      `Stopping: **${counts.stopping}**`,
      `Verifying mutation: **${counts.verifying}**`,
    ].join('\n'),
    inline: false,
  };
}

export function buildApiStatusEmbed(snapshot) {
  const toMB = (value) => (value / 1024 / 1024).toFixed(1);
  const questDetails = questDetailLines(snapshot.aggregate);
  const accountDetails = accountDetailText(snapshot.accountStatuses);
  const embed = new EmbedBuilder()
    .setTitle('🔌 NeverDie System Status')
    .setColor(selectStatusColor(snapshot.dbOk, snapshot.aggregate.state))
    .addFields(
      { name: 'Database', value: snapshot.dbOk ? '🟢 OK' : '🔴 Error', inline: true },
      { name: 'Query Latency', value: `${snapshot.latency}ms`, inline: true },
      { name: 'Bot Ping', value: `${snapshot.ping}ms`, inline: true },
      { name: 'RAM (RSS)', value: `${toMB(snapshot.memory.rss)} MB`, inline: true },
      { name: 'Heap ที่ใช้', value: `${toMB(snapshot.memory.heapUsed)} MB`, inline: true },
      { name: 'Heap ทั้งหมด', value: `${toMB(snapshot.memory.heapTotal)} MB`, inline: true },
      topologyField(snapshot),
      transportField(snapshot.transport),
      runnerField(snapshot),
      { name: 'Discord Quest API — สรุปรวม', value: questDetails.join('\n').slice(0, 1024) },
      { name: 'สถานะบัญชีของคุณ', value: accountDetails.slice(0, 1024) },
      {
        name: 'หลักฐานจาก Discord — รวม',
        value: [
          `ยืนยัน progress: ${discordTime(snapshot.aggregate.lastVerifiedProgressAt)}`,
          `ยืนยัน completed_at: ${discordTime(snapshot.aggregate.lastVerifiedCompletionAt)}`,
          `ยืนยัน claimed_at: ${discordTime(snapshot.aggregate.lastVerifiedClaimAt)}`,
        ].join('\n'),
      },
    )
    .setTimestamp();

  if (snapshot.dbError) {
    embed.addFields({
      name: '❌ Database Error',
      value: `\`${redactSensitive(snapshot.dbError).slice(0, 900)}\``,
    });
  }
  if (snapshot.aggregate.lastError) {
    embed.addFields({
      name: '❌ Quest API Error ล่าสุด',
      value: `\`${redactSensitive(snapshot.aggregate.lastError).slice(0, 900)}\``,
    });
  }
  return embed;
}

function collectStatusSnapshot(interaction) {
  const health = databaseHealth();
  return {
    ...health,
    ping: interaction.client.ws.ping,
    memory: process.memoryUsage(),
    aggregate: getQuestEngineStatus(),
    accountStatuses: listQuestEngineStatuses({ ownerId: interaction.user.id }),
    jobs: listJobs(),
    persisted: listScheduledRunners(),
    activeDurable: listRunnerStates({
      ownerId: interaction.user.id,
      activeOnly: true,
      limit: 50,
    }),
    activeRoles: listActiveProcessRoles(),
    workerHolders: new Set(listActiveWorkerHolders()),
    activeClaims: listScheduledRunnerClaims({ activeOnly: true }),
    transport: getDiscordApiRuntimeStatus(),
  };
}

export async function execute(interaction) {
  if (!isManager(interaction)) {
    return interaction.reply({
      flags: 64,
      content: '🔒 ต้องการสิทธิ์ **Manager** ขึ้นไปจึงจะดูสถานะระบบได้',
    });
  }

  await interaction.deferReply({ flags: 64 });
  const snapshot = collectStatusSnapshot(interaction);
  return interaction.editReply({ embeds: [buildApiStatusEmbed(snapshot)] });
}
