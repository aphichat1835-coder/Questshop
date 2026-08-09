import { withTransaction } from '../../db/transaction.js';
import { QuestshopError } from '../../shared/errors.js';
import { renderSurfaceAnchor } from '../renderers/surfaces.js';
import { appendAdminAudit } from '../../domain/admin/audit.js';
import { assertPrivateSurface } from './privacy.js';

const PRIVATE = new Set(['LOG_PAYMENTS', 'LOG_QUEST_OPERATIONS', 'LOG_ADMIN', 'LOG_SYSTEM', 'ADMIN_PANEL']);

function surfacePayload(surfaceKey, config) {
  const body = renderSurfaceAnchor(surfaceKey, config?.values ?? config);
  body.embeds?.[0]?.setFooter?.({ text: `Questshop Surface • ${surfaceKey}` });
  return body;
}

async function findSurfaceMarker(channel, surfaceKey) {
  const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  return messages?.find((message) => message.author?.id === channel.client.user?.id
    && message.embeds?.[0]?.footer?.text === `Questshop Surface • ${surfaceKey}`) ?? null;
}

export async function setupSurface({ interaction, surfaceKey, config }, context, options = {}) {
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  if (!channel?.isTextBased() || channel.isDMBased()) {
    throw new QuestshopError('SURFACE_CHANNEL_INVALID', 'ต้องเลือกห้องข้อความในเซิร์ฟเวอร์');
  }
  const member = await interaction.guild.members.fetchMe();
  if (PRIVATE.has(surfaceKey)) {
    const adminRoleId = config?.values?.adminRoleId;
    try {
      assertPrivateSurface({ channel, guild: interaction.guild, botMember: member, adminRoleId,
        ownerId: interaction.client.questshop?.env?.OWNER_ID ?? interaction.guild.ownerId });
    } catch (error) {
      throw new QuestshopError(error.code ?? 'PRIVATE_SURFACE_EXPOSED', 'ห้องหลังบ้านยังไม่ปลอดภัยสำหรับข้อมูลร้าน');
    }
  }
  const existing = (await options.pool.query('SELECT * FROM surfaces WHERE surface_key = $1', [surfaceKey])).rows[0];
  let message = null;
  if (existing?.channel_id === channel.id && existing.message_id) {
    message = await channel.messages.fetch(existing.message_id).catch(() => null);
  }
  message ??= await findSurfaceMarker(channel, surfaceKey);
  const body = surfacePayload(surfaceKey, config);
  if (message) await message.edit(body);
  else message = await channel.send({ ...body, nonce: `surface-${surfaceKey.toLowerCase()}`, enforceNonce: true });
  await withTransaction({ ...options, isolation: 'SERIALIZABLE' }, async (client) => {
    await client.query(`
      INSERT INTO surfaces(surface_key, guild_id, channel_id, message_id,
        state, last_validated_at, rendered_config_version)
      VALUES ($1,$2,$3,$4,'ACTIVE',clock_timestamp(),$5)
      ON CONFLICT (surface_key) DO UPDATE SET guild_id = EXCLUDED.guild_id,
        channel_id = EXCLUDED.channel_id, message_id = EXCLUDED.message_id,
        state = 'ACTIVE',
        rendered_config_version = EXCLUDED.rendered_config_version,
        state_version = surfaces.state_version + 1, last_validated_at = clock_timestamp(),
        updated_at = clock_timestamp()
    `, [surfaceKey, interaction.guildId, channel.id, message.id, Number(config?.version ?? 0)]);
    await appendAdminAudit(client, { action: 'SURFACE_SETUP', targetType: 'SURFACE', targetId: surfaceKey,
      actorId: interaction.user.id, before: existing ?? null,
      after: { channelId: channel.id, messageId: message.id }, reason: 'setup command', context });
  });
  if (existing?.message_id && (existing.channel_id !== channel.id || existing.message_id !== message.id)) {
    const old = await interaction.guild.channels.fetch(existing.channel_id).catch(() => null);
    const oldMessage = old?.isTextBased() ? await old.messages.fetch(existing.message_id).catch(() => null) : null;
    await oldMessage?.edit({ content: 'แผงนี้ถูกย้ายแล้ว', embeds: [], components: [] }).catch(() => null);
  }
  return message;
}

export async function reconcileSurfaceAnchors({ client, pool, env, config }, context) {
  const surfaces = (await pool.query(`SELECT * FROM surfaces WHERE state IN ('ACTIVE','RECONCILING')`)).rows;
  const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
  const results = [];
  for (const surface of surfaces) {
    const channel = await guild.channels.fetch(surface.channel_id).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased()) continue;
    let message = surface.message_id
      ? await channel.messages.fetch(surface.message_id).catch(() => null) : null;
    message ??= await findSurfaceMarker(channel, surface.surface_key);
    if (!message) {
      message = await channel.send({ ...surfacePayload(surface.surface_key, config),
        nonce: `surface-${surface.surface_key.toLowerCase()}`, enforceNonce: true });
      await withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (database) => {
        const updated = (await database.query(`UPDATE surfaces SET message_id=$2,state='ACTIVE',
          rendered_config_version=$4,state_version=state_version+1,updated_at=clock_timestamp()
          WHERE surface_key=$1 AND state_version=$3 RETURNING *`,
        [surface.surface_key, message.id, surface.state_version, Number(config?.version ?? 0)])).rows[0];
        if (!updated) return;
        await appendAdminAudit(database, { action: 'SURFACE_RECONCILED', targetType: 'SURFACE',
          targetId: surface.surface_key, actorId: context.actorId,
          before: { messageId: surface.message_id, state: surface.state },
          after: { messageId: message.id, state: 'ACTIVE' }, reason: 'anchor missing during reconciliation', context });
      });
      results.push({ surfaceKey: surface.surface_key, recreated: true, messageId: message.id });
    } else if (surface.state === 'RECONCILING'
      || Number(surface.rendered_config_version) < Number(config?.version ?? 0)) {
      await message.edit(surfacePayload(surface.surface_key, config));
      await pool.query(`UPDATE surfaces SET state='ACTIVE',rendered_config_version=$2,
        state_version=state_version+1,updated_at=clock_timestamp()
        WHERE surface_key=$1 AND state_version=$3`,
      [surface.surface_key, Number(config?.version ?? 0), surface.state_version]);
      results.push({ surfaceKey: surface.surface_key, recreated: false,
        refreshed: true, messageId: message.id });
    }
  }
  return results;
}
