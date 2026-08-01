import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('แสดงคำสั่งทั้งหมดของบอท');

export async function execute(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('📋 NeverDie Quest Bot — คำสั่งทั้งหมด')
    .setColor(0x5865f2)
    .addFields(
      {
        name: '🎛️ แผงควบคุม',
        value: '`/panel` — เริ่ม One-shot Runner; เมื่อทำครบหรือไม่พบ Quest ระบบจะหยุดเอง',
      },
      {
        name: '🤖 Auto Daily Runner',
        value: [
          '`/run` — เริ่มระบบตรวจอัตโนมัติเวลา 00:00 / 08:00 / 16:00 น.',
          '`/stop` — เปิดแผงส่วนตัว เลือกหยุดหนึ่ง หลาย Token หรือทั้งหมด',
        ].join('\n'),
      },
      {
        name: '🔧 ระบบ',
        value: [
          '`/api-status` — เช็กระบบและหลักฐานล่าสุดจาก Discord Quest API (Manager ขึ้นไป)',
          '`/ping` — เช็กว่าบอทออนไลน์',
          '`/help` — แสดงหน้านี้',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'NeverDie Quest Helper Bot' });

  await interaction.reply({ embeds: [embed] });
}
