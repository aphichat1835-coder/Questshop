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

function compactBaht(cents) {
  const value = BigInt(cents);
  const whole = value / 100n;
  const fraction = String(value % 100n).padStart(2, '0');
  return fraction === '00' ? whole.toString() : `${whole}.${fraction}`;
}

export function questPriceRangeText(priceRange) {
  if (priceRange?.minCents == null || priceRange?.maxCents == null) return 'ตามราคาที่กำหนด';
  const minimum = BigInt(priceRange.minCents);
  const maximum = BigInt(priceRange.maxCents);
  const minimumText = compactBaht(minimum);
  if (minimum === maximum) return `${minimumText} บาท`;
  return `${minimumText}-${compactBaht(maximum)} บาท`;
}

export function renderQuestAuto(config = {}) {
  const price = questPriceRangeText(config.priceRange);
  const description = [
    'ทำ Quest เพื่อสะสม **Discord Orbs** ด้วยระบบอัตโนมัติ',
    `**ค่าบริการ ${price} / เควสสำเร็จ**`,
    'ใช้ **Discord Token** เพื่อให้ระบบเข้าไปทำ Quest ให้โดยอัตโนมัติ',
    'เลือก Quest ที่ต้องการ แล้วติดตามสถานะได้จนสำเร็จ',
  ].join('\n');
  const embed = new EmbedBuilder().setColor(COLORS.primary)
    .setTitle(truncateDiscordText('Discord Quest • Auto', DISCORD_LIMITS.embedTitle))
    .setDescription(truncateDiscordText(description, DISCORD_LIMITS.embedDescription));
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
  if (surfaceKey === 'QUEST_AUTO') return renderQuestAuto({
    ...(config.branding ?? {}),
    priceRange: config.questAutoPriceRange,
  });
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
