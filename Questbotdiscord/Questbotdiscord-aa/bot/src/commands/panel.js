import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { getUserJobs } from '../quest/runner-service.js';
import { stopRunnerAndWaitDetailed } from '../runner-control.js';
import { isManager } from '../permissions.js';
import { showRunModal } from './run.js';

export const data = new SlashCommandBuilder()
  .setName('panel')
  .setDescription('เปิดแผงควบคุม NeverDie Auto Quest');

function managerRequiredPayload() {
  return { flags: 64, content: '🔒 ต้องการสิทธิ์ **Manager** ขึ้นไป' };
}

export async function execute(interaction) {
  return sendPanel(interaction, false);
}

export async function sendPanel(interaction, isUpdate = false) {
  const oneShotJobs = getUserJobs(interaction.user.id, { mode: 'oneshot' }).length;
  const scheduledJobs = getUserJobs(interaction.user.id, { mode: 'scheduled' }).length;

  const embed = new EmbedBuilder()
    .setTitle('🔥 AUTO QUEST SYSTEM')
    .setColor(0xff3333)
    .setDescription([
      '```',
      'PREMIUM PANEL ENABLED',
      '```',
      '• **START NOW** เริ่ม One-shot Runner',
      '• **STOP ALL** หยุด One-shot Runner ของผู้กดทั้งหมด',
      '• Auto Daily ใช้ `/run` และจัดการผ่าน `/stop`',
    ].join('\n'))
    .setFooter({
      text: `POWERED BY NEVERDIE AUTO QUEST™ · One-shot: ${oneShotJobs} · Auto Daily: ${scheduledJobs}`,
    })
    .setTimestamp();

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('panel:run')
      .setLabel('🚀 START NOW')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('panel:stop')
      .setLabel('🔴 STOP ALL')
      .setStyle(ButtonStyle.Danger),
  );

  const payload = { embeds: [embed], components: [controls] };
  if (isUpdate) return interaction.update(payload);
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

async function handleRunButton(interaction) {
  if (!isManager(interaction)) return interaction.reply(managerRequiredPayload());
  return showRunModal(interaction, 'oneshot');
}

async function handleStopButton(interaction) {
  await interaction.deferReply({ flags: 64 });
  const result = await stopRunnerAndWaitDetailed(interaction.user.id, { mode: 'oneshot' });

  let content = 'ℹ️ ไม่มี One-shot Runner ที่กำลังทำงาน';
  if (result.accepted > 0 && result.pending > 0) {
    content = `🛑 รับคำสั่งหยุดแล้ว **${result.accepted}** token · ยัง Cleanup อยู่ **${result.pending}** token`;
  } else if (result.completed > 0) {
    content = `🛑 หยุด One-shot Runner และ Cleanup เสร็จแล้ว **${result.completed}** token`;
  }
  return interaction.editReply(content);
}

export async function handleButton(interaction) {
  const action = interaction.customId.split(':')[1];
  if (action === 'run') return handleRunButton(interaction);
  if (action === 'stop') return handleStopButton(interaction);

  const payload = {
    flags: 64,
    content: 'ℹ️ ปุ่มนี้เป็นของ Panel รุ่นเก่าและถูกปิดใช้งานแล้ว กรุณาใช้ `/panel` เพื่อสร้างแผงใหม่',
  };
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}
