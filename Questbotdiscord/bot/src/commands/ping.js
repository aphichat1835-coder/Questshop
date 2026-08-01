import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('เช็กว่าบอทออนไลน์และ latency เท่าไหร่');

export async function execute(interaction) {
  const sent    = await interaction.reply({ content: '🏓 กำลังวัด...', fetchReply: true });
  const latency = sent.createdTimestamp - interaction.createdTimestamp;
  const ws      = interaction.client.ws.ping;

  await interaction.editReply(
    `🏓 **Pong!**\n> Round-trip: **${latency}ms**\n> WebSocket: **${ws >= 0 ? ws + 'ms' : 'N/A'}**`
  );
}
