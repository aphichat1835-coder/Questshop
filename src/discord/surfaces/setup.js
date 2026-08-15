import { createHash } from 'node:crypto';
import { withTransaction } from '../../db/transaction.js';
import { QuestshopError } from '../../shared/errors.js';
import { renderSurfaceAnchor } from '../renderers/surfaces.js';
import { appendAdminAudit } from '../../domain/admin/audit.js';
import { fetchDiscordMessage, findDiscordMessage, isMissingDiscordMessage } from '../transport.js';

function surfacePayload(surfaceKey, config) {
  const body = renderSurfaceAnchor(surfaceKey, config?.values ?? config);
  body.embeds?.[0]?.setFooter?.({ text: `Questshop Surface • ${surfaceKey}` });
  return body;
}

async function findSurfaceMarker(channel, surfaceKey) {
  return findDiscordMessage(channel, (message) => message.author?.id === channel.client.user?.id
    && message.embeds?.[0]?.footer?.text === `Questshop Surface • ${surfaceKey}`);
}

export async function fetchSurfaceMessageFresh(channel, messageId) {
  return fetchDiscordMessage(channel, messageId);
}

export function surfaceNonce(surfaceKey) {
  const readable = `surface-${surfaceKey.toLowerCase()}`;
  if (readable.length <= 25) return readable;
  const prefix = surfaceKey.toLowerCase().replaceAll('_', '').slice(0, 8);
  const digest = createHash('sha256').update(surfaceKey).digest('hex').slice(0, 8);
  return `surface-${prefix}-${digest}`;
}

export async function updateOrCreateSurfaceAnchor(channel, surfaceKey, config, existingMessage = null) {
  const body = surfacePayload(surfaceKey, config);
  let message = existingMessage;
  if (message) {
    try {
      return { message: await message.edit(body), recreated: false };
    } catch (error) {
      if (!isMissingDiscordMessage(error)) throw error;
      message = null;
    }
  }
  message = await findSurfaceMarker(channel, surfaceKey);
  if (message) {
    try {
      return { message: await message.edit(body), recreated: false };
    } catch (error) {
      if (!isMissingDiscordMessage(error)) throw error;
    }
  }
  const created = await channel.send({ ...body, nonce: surfaceNonce(surfaceKey), enforceNonce: true });
  return { message: created, recreated: true };
}

export async function setupSurface({ interaction, surfaceKey, config }, context, options = {}) {
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  if (!channel?.isTextBased() || channel.isDMBased()) {
    throw new QuestshopError('SURFACE_CHANNEL_INVALID', 'ต้องเลือกห้องข้อความในเซิร์ฟเวอร์');
  }
  const existing = (await options.pool.query('SELECT * FROM surfaces WHERE surface_key = $1', [surfaceKey])).rows[0];
  let message = null;
  if (existing?.channel_id === channel.id && existing.message_id) {
    message = await fetchSurfaceMessageFresh(channel, existing.message_id);
  }
  message ??= await findSurfaceMarker(channel, surfaceKey);
  const anchor = await updateOrCreateSurfaceAnchor(channel, surfaceKey, config, message);
  message = anchor.message;
  try {
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
  } catch (error) {
    if (anchor.recreated) await deactivateOrphan(message, options.pool, surfaceKey, context);
    throw error;
  }
  if (existing?.message_id && (existing.channel_id !== channel.id || existing.message_id !== message.id)) {
    try {
      const old = await interaction.guild.channels.fetch(existing.channel_id);
      const oldMessage = old?.isTextBased() ? await fetchSurfaceMessageFresh(old, existing.message_id) : null;
      await oldMessage?.edit({ content: 'แผงนี้ถูกย้ายแล้ว', embeds: [], components: [] });
    } catch (error) {
      await recordSurfaceIncidentSafely(options.pool, surfaceKey, error, context);
    }
  }
  return message;
}

async function recordSurfaceIncident(pool, surfaceKey, error, context) {
  return pool.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
    VALUES(gen_random_uuid(),'DISCORD_SURFACE_RECONCILE_FAILED',$1,'OPEN','ERROR',$2,$3)
    ON CONFLICT (incident_code,scope) WHERE state<>'RESOLVED' DO UPDATE SET
      evidence=EXCLUDED.evidence,updated_at=clock_timestamp()`, [surfaceKey, {
    code: String(error?.code ?? error?.name ?? 'UNKNOWN').slice(0, 100),
    status: Number(error?.status) || null,
  }, context.traceId]);
}

async function recordSurfaceIncidentSafely(pool, surfaceKey, error, context) {
  try {
    await recordSurfaceIncident(pool, surfaceKey, error, context);
  } catch {
    // A database outage is already the authoritative failure.  Do not hide
    // the original Discord error or stop reconciliation of other surfaces.
  }
}

async function deactivateOrphan(message, pool, surfaceKey, context) {
  try {
    await message.edit({ content: 'แผงนี้ถูกแทนที่แล้ว', embeds: [], components: [] });
  } catch (error) {
    // The authoritative surface pointer remains unchanged; the next pass will
    // report the delivery failure without treating the orphan as active.
    await recordSurfaceIncidentSafely(pool, surfaceKey, error, context);
  }
}

async function persistReconciledSurface(pool, surface, message, config, anchor, context) {
  return withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (database) => {
    const updated = (await database.query(`UPDATE surfaces SET message_id=$2,state='ACTIVE',
      rendered_config_version=$4,state_version=state_version+1,updated_at=clock_timestamp()
      WHERE surface_key=$1 AND state_version=$3 RETURNING *`,
    [surface.surface_key, message.id, surface.state_version, Number(config?.version ?? 0)])).rows[0];
    if (!updated) return null;
    await appendAdminAudit(database, { action: 'SURFACE_RECONCILED', targetType: 'SURFACE',
      targetId: surface.surface_key, actorId: context.actorId,
      before: { messageId: surface.message_id, state: surface.state },
      after: { messageId: message.id, state: 'ACTIVE' },
      reason: anchor.recreated ? 'anchor missing during reconciliation' : 'anchor refreshed or recovered by marker', context });
    return updated;
  });
}

async function reconcileOneSurface({ guild, pool, surface, config, context }) {
  const channel = await guild.channels.fetch(surface.channel_id);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    throw new QuestshopError('SURFACE_CHANNEL_INVALID', 'Surface channel is unavailable');
  }
  let message = surface.message_id ? await fetchSurfaceMessageFresh(channel, surface.message_id) : null;
  message ??= await findSurfaceMarker(channel, surface.surface_key);
  const needsRefresh = !message || surface.state === 'RECONCILING'
    || Number(surface.rendered_config_version) < Number(config?.version ?? 0);
  if (!needsRefresh) return { surfaceKey: surface.surface_key, skipped: true };
  const anchor = await updateOrCreateSurfaceAnchor(channel, surface.surface_key, config, message);
  const updated = await persistReconciledSurface(pool, surface, anchor.message, config, anchor, context);
  if (updated) {
    return { surfaceKey: surface.surface_key, recreated: anchor.recreated,
      refreshed: Boolean(message), messageId: anchor.message.id };
  }
  if (anchor.recreated) await deactivateOrphan(anchor.message, pool, surface.surface_key, context);
  return { surfaceKey: surface.surface_key, reconciled: false, reason: 'STALE_SURFACE' };
}

export async function reconcileSurfaceAnchors({ client, pool, env, config }, context) {
  const surfaces = (await pool.query(`SELECT * FROM surfaces WHERE state IN ('ACTIVE','RECONCILING')`)).rows;
  const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
  const results = [];
  for (const surface of surfaces) {
    try {
      results.push(await reconcileOneSurface({ guild, pool, surface, config, context }));
    } catch (error) {
      await recordSurfaceIncidentSafely(pool, surface.surface_key, error, context);
      results.push({ surfaceKey: surface.surface_key, reconciled: false,
        reason: String(error?.code ?? error?.name ?? 'DISCORD_ERROR') });
    }
  }
  return results;
}
