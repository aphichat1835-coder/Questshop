import { EmbedBuilder } from 'discord.js';
import { questTargetLabel, questTypeLabel } from './labels.js';
import { baht } from './checkout.js';
import { DISCORD_LIMITS, safeDiscordText, truncateDiscordText } from '../payload.js';

const QUEST_COLOR = 0x5865f2;
const noMentions = { parse: [] };
const escape = (value) => safeDiscordText(value, { maximum: 1_000 });
const title = (value) => truncateDiscordText(value, DISCORD_LIMITS.embedTitle);
const boundedDescription = (value) => truncateDiscordText(value, DISCORD_LIMITS.embedDescription);
const timestamp = (value) => value ? `<t:${Math.floor(new Date(value).getTime() / 1000)}:F>` : 'ไม่ระบุ';

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    const normalized = url.protocol === 'https:' ? url.toString() : null;
    return normalized && normalized.length <= 512 ? normalized : null;
  } catch {
    return null;
  }
}

export async function renderQuestNewProjection(pool, projection) {
  const quest = (await pool.query(`SELECT q.*,resolved.amount_cents AS price_cents,
    media.thumbnail_url
    FROM quests q
    LEFT JOIN LATERAL (SELECT p.amount_cents FROM price_rules p
      WHERE p.enabled=true AND p.rule_type='TYPE' AND p.task_type=q.task_type
      ORDER BY p.created_at DESC LIMIT 1) resolved ON true
    LEFT JOIN LATERAL (
      SELECT m.normalized->>'thumbnailUrl' AS thumbnail_url
      FROM quest_metadata_revisions m
      WHERE m.quest_id=q.quest_id AND NULLIF(m.normalized->>'thumbnailUrl','') IS NOT NULL
      ORDER BY m.revision DESC LIMIT 1
    ) media ON true
    WHERE q.quest_id=$1`, [projection.aggregate_id])).rows[0];
  if (!quest) {
    return { embeds: [new EmbedBuilder().setColor(QUEST_COLOR).setTitle('ไม่พบข้อมูล Quest ใหม่')],
      allowedMentions: noMentions };
  }

  const price = quest.price_cents == null ? 'ยังไม่กำหนด' : baht(quest.price_cents);
  const questUrl = safeHttpsUrl(quest.url);
  const description = [
    `**ประเภท:** ${questTypeLabel(quest.task_type)}`,
    `**เป้าหมาย:** ${questTargetLabel(quest.task_type, quest.task_target)}`,
    `**รางวัล:** ${quest.orbs ?? 'ไม่ระบุ'} Orbs`,
    `**ค่าบริการ:** ${price}`,
    questUrl ? `**[ดู Quest ได้ที่นี่](${questUrl})**` : null,
    '',
    `**เริ่ม Quest:** ${timestamp(quest.starts_at)}`,
    `**หมดอายุ:** ${timestamp(quest.expires_at)}`,
  ].filter(Boolean).join('\n');

  const embed = new EmbedBuilder().setColor(QUEST_COLOR)
    .setTitle(title(`🎉 พบ Quest ใหม่: ${escape(quest.name)}`))
    .setDescription(boundedDescription(description));
  if (questUrl) embed.setURL(questUrl);

  const artworkUrl = safeHttpsUrl(quest.artwork_url);
  const thumbnailUrl = safeHttpsUrl(quest.thumbnail_url);
  if (artworkUrl) embed.setImage(artworkUrl);
  if (thumbnailUrl && thumbnailUrl !== artworkUrl) embed.setThumbnail(thumbnailUrl);

  return { embeds: [embed], allowedMentions: noMentions };
}
