import {
  ActionRowBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from '../config.js';
import {
  fetchMe,
  findAnyJobByAccount,
  getUserJobs,
  startRunner,
} from '../quest/runner-service.js';
import { isAccountStopping } from '../runner-control.js';
import {
  withAccountAdmissionLock,
  withOwnerAdmissionLock,
} from '../run-admission-lock.js';
import { isManager } from '../permissions.js';
import {
  createScheduledRunner,
  deleteScheduledRunner,
  findAnyScheduledRunner,
  listScheduledRunners,
} from '../scheduled-runner-store.js';

const MAX_TOKENS_PER_SUBMISSION = 10;

export const data = new SlashCommandBuilder()
  .setName('run')
  .setDescription('เริ่ม Auto Quest อัตโนมัติ (รองรับหลาย TOKEN พร้อมกัน)');

export async function execute(interaction) {
  if (!isManager(interaction)) {
    return interaction.reply({ flags: 64, content: '🔒 ต้องการสิทธิ์ **Manager** ขึ้นไปจึงจะใช้คำสั่งนี้ได้' });
  }
  if (!config.runnerTokenSecret || config.runnerTokenSecret.length < 16) {
    return interaction.reply({
      flags: 64,
      content: '❌ Scheduled Runner ยังไม่พร้อม — กรุณาตั้ง `RUNNER_TOKEN_SECRET` อย่างน้อย 16 ตัวอักษรใน Environment',
    });
  }
  return showRunModal(interaction, 'scheduled');
}

export async function showRunModal(interaction, mode = 'scheduled') {
  const modal = new ModalBuilder()
    .setCustomId(`run_modal:${mode}:${interaction.channelId}`)
    .setTitle(mode === 'scheduled' ? '🤖 AUTO DAILY QUEST' : '🔥 AUTO QUEST LOGIN');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('user_tokens')
        .setLabel('DISCORD TOKENS')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('1 TOKEN ต่อ 1 บรรทัด')
        .setRequired(true)
        .setMaxLength(4000),
    ),
  );

  try {
    await interaction.showModal(modal);
  } catch (error) {
    if (error?.code === 10062 || error?.code === 40060) return;
    throw error;
  }
}

function tokenCheckFailure(error, tokenIndex) {
  const prefix = `❌ Token ลำดับที่ ${tokenIndex + 1}`;
  if (error?.status === 401 || error?.status === 403) {
    return `${prefix} ไม่ถูกต้องหรือไม่มีสิทธิ์เข้าถึงบัญชี`;
  }
  if (error?.status === 429) {
    return `${prefix} ตรวจไม่ได้ชั่วคราว — Discord จำกัดคำขอ กรุณาลองใหม่ภายหลัง`;
  }
  if (Number.isInteger(error?.status) && error.status >= 500) {
    return `${prefix} ตรวจไม่ได้ชั่วคราว — Discord API ขัดข้อง (${error.status})`;
  }
  if (error?.name === 'RequestTimeoutError') {
    return `${prefix} ตรวจไม่สำเร็จ — การเชื่อมต่อหมดเวลา`;
  }
  return `${prefix} ตรวจไม่สำเร็จ — ติดต่อ Discord ไม่ได้`;
}

function parseModalContext(interaction) {
  const parts = interaction.customId.split(':');
  const explicitMode = parts.length >= 3;
  const mode = explicitMode ? parts[1] : 'oneshot';
  const modalChannelId = explicitMode ? parts[2] : parts[1];
  return {
    mode,
    channelId: interaction.channelId ?? modalChannelId,
    isScheduled: mode === 'scheduled',
    valid: mode === 'scheduled' || mode === 'oneshot',
  };
}

function parseTokens(interaction) {
  const raw = interaction.fields.getTextInputValue('user_tokens');
  return [...new Set(raw.split('\n').map((token) => token.trim()).filter(Boolean))];
}

function availableRunnerSlots(ownerId) {
  const existing = getUserJobs(ownerId, { includeStopping: true });
  const persisted = listScheduledRunners(ownerId);
  const runningScheduledIds = new Set(
    existing.filter((job) => job.scheduleId != null).map((job) => job.scheduleId),
  );
  const offlineScheduled = persisted.filter((row) => !runningScheduledIds.has(row.id)).length;
  return Math.max(0, 10 - existing.length - offlineScheduled);
}

async function inspectToken(token, tokenIndex) {
  try {
    const account = await fetchMe(token);
    if (!account?.id) {
      return { error: `❌ Token ลำดับที่ ${tokenIndex + 1} ไม่คืนข้อมูลบัญชีที่ใช้งานได้` };
    }
    return { account };
  } catch (error) {
    return { error: tokenCheckFailure(error, tokenIndex) };
  }
}

function accountConflict(ownerId, account) {
  if (isAccountStopping(ownerId, account.id)) {
    return `⏳ **${account.username}** กำลังหยุดและ Cleanup กรุณาลองใหม่อีกครั้ง`;
  }
  if (findAnyJobByAccount(account.id) || findAnyScheduledRunner(account.id)) {
    return `⚠️ **${account.username}** มี Runner ทำงานอยู่แล้วในระบบ`;
  }
  return null;
}

function createSchedule(context, token, account) {
  if (!context.isScheduled) return null;
  return createScheduledRunner({
    ownerId: context.ownerId,
    guildId: context.interaction.guildId,
    channelId: context.channelId,
    accountId: account.id,
    username: account.username,
    token,
    secret: config.runnerTokenSecret,
  });
}

function runnerSuccessLine(isScheduled, username, queued = false) {
  if (isScheduled && queued) {
    return `🤖 ส่งเข้าคิว Scheduled Worker: **${username}**\n   Worker จะตรวจทันทีและทำงานตามรอบ **00:00 / 08:00 / 16:00 น.**`;
  }
  if (isScheduled) {
    return `🤖 เริ่มระบบอัตโนมัติรายวัน: **${username}**\n   ตรวจทันที และตรวจประจำเวลา **00:00 / 08:00 / 16:00 น.**`;
  }
  return `✅ เริ่ม Quest auto : **${username}**`;
}

async function startAccountRunner(context, token, account) {
  let schedule = null;
  try {
    schedule = createSchedule(context, token, account);
    const jobKey = context.isScheduled
      ? `scheduled:${schedule.id}`
      : `${context.ownerId}:oneshot:${context.nextStartIndex()}`;
    const startResult = await startRunner({
      jobKey,
      ownerId: context.ownerId,
      userToken: token,
      channelId: context.channelId,
      client: context.interaction.client,
      mode: context.isScheduled ? 'scheduled' : 'oneshot',
      scheduleId: schedule?.id ?? null,
      accountId: account.id,
      username: account.username,
    });
    return {
      started: true,
      line: runnerSuccessLine(context.isScheduled, account.username, startResult?.queued === true),
    };
  } catch (error) {
    if (schedule) deleteScheduledRunner(schedule.id, context.ownerId);
    return { started: false, line: `❌ เริ่ม **${account.username}** ไม่สำเร็จ — ${error.message}` };
  }
}

async function processTokens(context, tokens, freeSlots) {
  const results = [];
  let started = 0;
  let inspected = 0;

  for (const [tokenIndex, token] of tokens.entries()) {
    if (started >= freeSlots) break;
    inspected++;

    const inspection = await inspectToken(token, tokenIndex);
    if (inspection.error) {
      results.push(inspection.error);
      continue;
    }

    const outcome = await withAccountAdmissionLock(inspection.account.id, async () => {
      const conflict = accountConflict(context.ownerId, inspection.account);
      if (conflict) return { started: false, line: conflict };
      return startAccountRunner(context, token, inspection.account);
    });
    results.push(outcome.line);
    if (outcome.started) started++;
  }

  return { results, inspected };
}

function finalizeResults(results, tokens, inspected, isScheduled) {
  const skipped = tokens.length - inspected;
  if (skipped > 0) results.push(`⚠️ ข้าม ${skipped} token เพราะช่อง Runner เต็ม`);

  const scheduledStarted = isScheduled && results.some((line) => line.startsWith('🤖'));
  if (scheduledStarted) {
    results.unshift('**🚀 NEVERDIE AUTO DAILY QUEST เปิดใช้งานแล้ว**');
    results.push('ใช้คำสั่ง `/stop` เพื่อเลือกหยุด Runner ที่ต้องการ');
  }
  return results.join('\n');
}

async function admitRunners(context, tokens) {
  const freeSlots = availableRunnerSlots(context.ownerId);
  if (freeSlots === 0) {
    return context.interaction.editReply(
      '⚠️ มี Runner ทำงานหรือกำลัง Cleanup เต็มแล้ว (สูงสุด 10 token) ใช้ 🛑 STOP ALL ก่อน',
    );
  }

  const { results, inspected } = await processTokens(context, tokens, freeSlots);
  return context.interaction.editReply(
    finalizeResults(results, tokens, inspected, context.isScheduled),
  );
}

export async function handleModal(interaction) {
  const modal = parseModalContext(interaction);
  if (!modal.valid) {
    return interaction.reply({ flags: 64, content: '❌ Runner mode ไม่ถูกต้อง กรุณาเปิด Modal ใหม่' });
  }
  if (!isManager(interaction)) {
    return interaction.reply({
      flags: 64,
      content: '🔒 สิทธิ์ของคุณเปลี่ยนไป — ต้องการสิทธิ์ **Manager** ขึ้นไป',
    });
  }

  const tokens = parseTokens(interaction);
  if (!tokens.length) {
    return interaction.reply({ flags: 64, content: '❌ ไม่พบ token กรุณาใส่อย่างน้อย 1 token' });
  }
  if (tokens.length > MAX_TOKENS_PER_SUBMISSION) {
    return interaction.reply({
      flags: 64,
      content: `❌ รับได้สูงสุด ${MAX_TOKENS_PER_SUBMISSION} token ต่อครั้ง กรุณาแบ่งส่งใหม่`,
    });
  }

  await interaction.deferReply(modal.isScheduled ? {} : { flags: 64 });
  const ownerId = interaction.user.id;
  let startIndex = Date.now();
  const context = {
    ...modal,
    interaction,
    ownerId,
    nextStartIndex: () => startIndex++,
  };

  return withOwnerAdmissionLock(ownerId, () => admitRunners(context, tokens));
}
