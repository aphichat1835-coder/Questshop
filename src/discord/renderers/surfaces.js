import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { customId } from '../components/custom-id.js';
import { adminCategoryOptions } from './admin.js';
import { DISCORD_LIMITS, truncateDiscordText } from '../payload.js';

const COLORS = Object.freeze({ primary: 0x5865f2, success: 0x23a55a, warning: 0xf0b232, danger: 0xf23f43 });

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.toString().length <= 512 ? url.toString() : null;
  } catch { return null; }
}

export function renderQuestAuto(config = {}) {
  const embed = new EmbedBuilder().setColor(COLORS.primary)
    .setTitle(truncateDiscordText(config.title ?? 'Discord Quest — ทำเควสอัตโนมัติ', DISCORD_LIMITS.embedTitle))
    .setDescription(truncateDiscordText(config.description ?? 'เติมเครดิต เลือก Quest ที่ต้องการ แล้วติดตามความคืบหน้าได้อัตโนมัติ\nระบบคิดค่าบริการเฉพาะ Quest ที่ทำสำเร็จเท่านั้น', DISCORD_LIMITS.embedDescription));
  const mediaUrl = safeHttpsUrl(config.mediaUrl);
  if (mediaUrl) embed.setImage(mediaUrl);
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
  const options = adminCategoryOptions();
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.primary).setTitle('แผงควบคุม Questshop')
      .setDescription('เลือกหมวดที่ต้องการจัดการจากเมนูด้านล่าง\nรายการที่มีผลต่อเงินจะให้ตรวจสอบและยืนยันซ้ำทุกครั้ง')],
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
    QUEST_NEW: 'Quest ใหม่', QUEST_HISTORY: 'ประวัติการทำ Quest', LOG_PAYMENTS: 'บันทึกการเติมเงิน',
    LOG_QUEST_OPERATIONS: 'บันทึกการทำ Quest', LOG_ADMIN: 'บันทึกการทำงานของแอดมิน', LOG_SYSTEM: 'เหตุขัดข้องของระบบ',
  };
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.primary).setTitle(truncateDiscordText(names[surfaceKey] ?? surfaceKey, DISCORD_LIMITS.embedTitle))
      .setDescription('Questshop ดูแลข้อความในห้องนี้และกู้การแจ้งเตือนที่ค้างอยู่ให้อัตโนมัติหลังระบบเริ่มใหม่')],
    allowedMentions: { parse: [] },
  };
}
