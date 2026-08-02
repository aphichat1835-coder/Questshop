import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { customId } from '../components/custom-id.js';

const COLORS = Object.freeze({ primary: 0x5865f2, success: 0x23a55a, warning: 0xf0b232, danger: 0xf23f43 });

export function renderQuestAuto(config = {}) {
  const embed = new EmbedBuilder().setColor(COLORS.primary)
    .setTitle(config.title ?? 'Discord Quest — ทำเควสอัตโนมัติ')
    .setDescription(config.description ?? 'เติมเครดิต เลือกเควส และติดตามผลได้จากแผงนี้\nระบบจะจองยอดก่อน และคิดเงินจริงเฉพาะเควสที่สำเร็จ');
  if (config.mediaUrl) embed.setImage(config.mediaUrl);
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('start')).setLabel('เริ่มทำเควส').setEmoji('🎮').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(customId('topup')).setLabel('เติมเงิน').setEmoji('💰').setStyle(ButtonStyle.Success),
    )],
    allowedMentions: { parse: [] },
  };
}

export function renderAdminPanel() {
  const options = [
    ['overview', 'Overview'], ['gates', 'Store และ Feature Gates'], ['catalog', 'Quest Catalog'],
    ['pricing', 'Pricing'], ['promotions', 'Promotions'], ['orders', 'Orders และ Runner'],
    ['payments', 'Payments และ Manual Review'], ['wallet', 'Wallet / Refund / Adjustment'],
    ['blocklist', 'Blocklist'], ['monitors', 'Monitor Accounts'], ['receivers', 'Receiver Versions'],
    ['surfaces', 'Surfaces และ Permissions'], ['dlq', 'DLQ และ Incidents'], ['backup', 'Backup / Restore'],
    ['branding', 'Branding / Config'], ['secrets', 'Secret/Key version status'],
  ].map(([value, label]) => ({ value, label }));
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.primary).setTitle('Questshop Admin Panel')
      .setDescription('เลือกหมวดเพื่อเปิดแผงควบคุมแบบ Ephemeral\nการกระทำที่มีผลต่อเงินต้องมีเหตุผลและยืนยันซ้ำทุกครั้ง')],
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(customId('admin')).setPlaceholder('เลือกหมวดการตั้งค่า').addOptions(options),
    )],
    allowedMentions: { parse: [] },
  };
}

export function renderSurfaceAnchor(surfaceKey, config = {}) {
  if (surfaceKey === 'QUEST_AUTO') return renderQuestAuto(config.branding);
  if (surfaceKey === 'ADMIN_PANEL') return renderAdminPanel();
  const names = {
    QUEST_NEW: 'Quest ใหม่', QUEST_HISTORY: 'ประวัติการทำ Quest', LOG_PAYMENTS: 'Payment Logs',
    LOG_QUEST_OPERATIONS: 'Quest Operations', LOG_ADMIN: 'Admin Audit', LOG_SYSTEM: 'System Incidents',
  };
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.primary).setTitle(names[surfaceKey] ?? surfaceKey)
      .setDescription('ข้อความหลักของห้องนี้บริหารโดย Questshop และจะถูกอัปเดตแบบ Durable Outbox')],
    allowedMentions: { parse: [] },
  };
}
