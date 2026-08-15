import { escapeMarkdown } from 'discord.js';

export const DISCORD_LIMITS = Object.freeze({
  content: 2_000,
  embedTitle: 256,
  embedDescription: 4_096,
  embedFieldName: 256,
  embedFieldValue: 1_024,
  embedTotal: 6_000,
  selectOptions: 25,
  selectOptionLabel: 100,
  selectOptionDescription: 100,
  buttonLabel: 80,
  customId: 100,
  nonce: 25,
});

export function truncateDiscordText(value, maximum, suffix = '…') {
  const text = String(value ?? '');
  if (text.length <= maximum) return text;
  if (maximum <= suffix.length) return text.slice(0, maximum);
  return `${text.slice(0, maximum - suffix.length)}${suffix}`;
}

export function safeDiscordText(value, { maximum = DISCORD_LIMITS.embedDescription, fallback = 'ไม่ระบุ' } = {}) {
  const text = String(value ?? fallback).replaceAll('@', '@\u200b');
  return truncateDiscordText(escapeMarkdown(text), maximum);
}

export function discordDescription(lines, maximum = DISCORD_LIMITS.embedDescription) {
  const output = [];
  let remaining = maximum;
  for (const line of lines.filter(Boolean)) {
    const separator = output.length ? 1 : 0;
    if (remaining <= separator) break;
    const bounded = truncateDiscordText(line, remaining - separator);
    output.push(bounded);
    remaining -= bounded.length + separator;
  }
  return output.join('\n');
}

export function customerErrorText(message, supportCode) {
  return truncateDiscordText(`${message}\nSupport: \`${supportCode}\``, DISCORD_LIMITS.content);
}
