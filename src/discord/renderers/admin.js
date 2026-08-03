import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { customId } from '../components/custom-id.js';

export const ADMIN_CATEGORIES = Object.freeze([
  ['overview', 'ภาพรวมร้าน'], ['gates', 'เปิด–ปิดระบบ'], ['catalog', 'จัดการ Quest'],
  ['pricing', 'ตั้งราคา'], ['promotions', 'โปรโมชั่น'], ['orders', 'งานลูกค้าและคิว'],
  ['payments', 'รายการเติมเงินที่ต้องตรวจ'], ['wallet', 'ปรับยอดและคืนเครดิต'],
  ['blocklist', 'ระงับการใช้งาน'], ['monitors', 'บัญชีตรวจสอบ Quest'], ['receivers', 'เบอร์รับเงิน TrueMoney'],
  ['surfaces', 'ห้องและแผงข้อความ'], ['dlq', 'งานค้างและเหตุขัดข้อง'], ['backup', 'สำรองและกู้ข้อมูล'],
  ['branding', 'ตั้งค่าหน้าร้าน'], ['secrets', 'สถานะกุญแจระบบ'],
]);

export function adminCategoryOptions(selected = null) {
  return ADMIN_CATEGORIES.map(([value, label]) => ({ value, label, default: value === selected }));
}

export function adminNavigationComponents(selected, actionRows = []) {
  const menu = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(customId('admin_nav')).setPlaceholder('เปลี่ยนหมวดการตั้งค่า')
    .addOptions(adminCategoryOptions(selected)));
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId(`admin_refresh_${selected}`)).setLabel('รีเฟรช')
      .setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
    new ButtonBuilder().setCustomId(customId('admin_refresh_overview')).setLabel('กลับภาพรวม')
      .setStyle(ButtonStyle.Secondary).setDisabled(selected === 'overview'),
  );
  return [menu, ...actionRows, controls];
}
