import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { stopScheduledJobAndWaitDetailed, summarizeStopResults } from '../runner-control.js';
import { listScheduledRunners } from '../scheduled-runner-store.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('เลือกหยุด Auto Daily Runner ของคุณ');

function shortStatus(row) {
  if (row.last_error) return `มีข้อผิดพลาด: ${row.last_error}`.slice(0, 100);
  if (row.next_check_at) {
    const next = new Date(row.next_check_at);
    if (Number.isFinite(next.getTime())) {
      return `ตรวจครั้งถัดไป ${next.toLocaleString('th-TH', { timeZone: config.timezone })}`.slice(0, 100);
    }
  }
  return 'ระบบอัตโนมัติรายวันกำลังทำงาน';
}

function stopPanelPayload(ownerId, notice = null) {
  const rows = listScheduledRunners(ownerId);
  const embed = new EmbedBuilder()
    .setTitle('🛑 AUTO DAILY RUNNER CONTROL')
    .setColor(rows.length ? 0xed4245 : 0x57f287)
    .setDescription(
      notice
        ? `${notice}\n\n${rows.length ? 'เลือก Token ที่ต้องการหยุดได้หลายรายการ' : 'ไม่มี Auto Daily Runner ที่กำลังทำงาน'}`
        : rows.length
          ? 'เลือก Token ที่ต้องการหยุดได้หลายรายการจากเมนูด้านล่าง'
          : 'ไม่มี Auto Daily Runner ที่กำลังทำงาน',
    )
    .setFooter({ text: `Active: ${rows.length} token` })
    .setTimestamp();

  const components = [];
  if (rows.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('runner-stop:select')
      .setPlaceholder('เลือก Token ที่ต้องการหยุด')
      .setMinValues(1)
      .setMaxValues(Math.min(rows.length, 10))
      .addOptions(rows.slice(0, 10).map((row) => ({
        label: row.username.slice(0, 100),
        description: shortStatus(row),
        value: String(row.id),
        emoji: '🤖',
      })));
    components.push(new ActionRowBuilder().addComponents(select));
  }

  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('runner-stop:refresh')
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('runner-stop:all')
      .setLabel('STOP ALL')
      .setEmoji('🛑')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(rows.length === 0),
  ));

  return { embeds: [embed], components };
}

async function acknowledgeForCleanup(interaction) {
  if (typeof interaction.deferUpdate === 'function') {
    await interaction.deferUpdate();
    return true;
  }
  return false;
}

async function finishUpdate(interaction, payload, deferred) {
  if (deferred && typeof interaction.editReply === 'function') {
    return interaction.editReply(payload);
  }
  if (typeof interaction.update === 'function') return interaction.update(payload);
  if (typeof interaction.editReply === 'function') return interaction.editReply(payload);
  throw new Error('Interaction does not support update or editReply');
}

async function replyUnknownAction(interaction) {
  const payload = {
    flags: 64,
    content: 'ℹ️ ปุ่มควบคุมนี้หมดอายุหรือไม่รองรับแล้ว กรุณาใช้ `/stop` เพื่อเปิดแผงใหม่',
  };
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}

async function stopRows(ownerId, rows) {
  const results = await Promise.all(
    rows.map((row) => stopScheduledJobAndWaitDetailed(ownerId, row.id)),
  );
  return summarizeStopResults(results);
}

function stopNotice(result, scope = '') {
  if (result.accepted === 0) return 'ℹ️ ไม่พบ Runner ที่เลือก';
  const target = scope ? ` ${scope}` : '';
  if (result.pending > 0) {
    return `🛑 รับคำสั่งหยุด${target}แล้ว **${result.accepted}** token · ยัง Cleanup อยู่ **${result.pending}** token`;
  }
  return `✅ หยุดและ Cleanup${target}เสร็จแล้ว **${result.completed}** token`;
}

export async function execute(interaction) {
  return interaction.reply({
    ...stopPanelPayload(interaction.user.id),
    flags: 64,
  });
}

export async function handleSelect(interaction) {
  const deferred = await acknowledgeForCleanup(interaction);
  const selectedIds = new Set(
    interaction.values.map(Number).filter(Number.isInteger),
  );
  const rows = listScheduledRunners(interaction.user.id)
    .filter((row) => selectedIds.has(row.id));
  const result = await stopRows(interaction.user.id, rows);
  return finishUpdate(
    interaction,
    stopPanelPayload(interaction.user.id, stopNotice(result)),
    deferred,
  );
}

export async function handleButton(interaction) {
  const action = interaction.customId.split(':')[1];
  if (action === 'refresh') {
    return interaction.update(stopPanelPayload(interaction.user.id, '🔄 อัปเดตสถานะแล้ว'));
  }

  if (action === 'all') {
    const deferred = await acknowledgeForCleanup(interaction);
    const rows = listScheduledRunners(interaction.user.id);
    const result = await stopRows(interaction.user.id, rows);
    return finishUpdate(
      interaction,
      stopPanelPayload(interaction.user.id, stopNotice(result, 'Auto Daily Runner')),
      deferred,
    );
  }

  return replyUnknownAction(interaction);
}
