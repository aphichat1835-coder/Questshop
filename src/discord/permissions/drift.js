import { PermissionFlagsBits } from 'discord.js';
import { withTransaction } from '../../db/transaction.js';
import { createContext } from '../../shared/correlation.js';
import { appendAdminAudit } from '../../domain/admin/audit.js';
import { QuestshopError } from '../../shared/errors.js';

const REQUIRED = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory];

function expectedPrivateAccess(guild, bot, env, adminRoleId) {
  return new Set([guild.roles.everyone.id, bot.id, env.OWNER_ID,
    ...(adminRoleId ? [adminRoleId] : []), ...bot.roles?.cache?.keys?.() ?? []]);
}

function unexpectedPrivateViewRoles(channel, guild, expectedAccess) {
  return [...guild.roles.cache.values()].filter((role) => role.id !== guild.roles.everyone.id
    && !expectedAccess.has(role.id) && channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel))
    .map((role) => role.id);
}

export async function checkPermissionDrift({ client, pool, env }) {
  const surfaces = (await pool.query('SELECT * FROM surfaces')).rows;
  const config = (await pool.query('SELECT payload FROM config_versions ORDER BY version DESC LIMIT 1')).rows[0]?.payload ?? {};
  const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
  const bot = await guild.members.fetchMe();
  const results = [];
  for (const surface of surfaces) {
    const channel = await guild.channels.fetch(surface.channel_id).catch(() => null);
    const missing = channel ? REQUIRED.filter((permission) => !channel.permissionsFor(bot)?.has(permission)).map(String) : ['CHANNEL_MISSING'];
    const expectedAccess = expectedPrivateAccess(guild, bot, env, config.adminRoleId);
    const unexpectedViewOverwrites = surface.expected_permissions?.private && channel
      ? [...channel.permissionOverwrites.cache.values()].filter((overwrite) =>
        overwrite.allow.has(PermissionFlagsBits.ViewChannel) && !expectedAccess.has(overwrite.id))
        .map((overwrite) => overwrite.id) : [];
    const unexpectedViewRoles = surface.expected_permissions?.private && channel
      ? unexpectedPrivateViewRoles(channel, guild, expectedAccess) : [];
    const exposed = Boolean(surface.expected_permissions?.private && channel
      && (channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)
        || unexpectedViewOverwrites.length || unexpectedViewRoles.length));
    const drifted = missing.length > 0 || exposed;
    await withTransaction({ pool, isolation: 'READ COMMITTED' }, async (db) => {
      await db.query(`UPDATE surfaces SET state=$2,last_validated_at=clock_timestamp(),
        state_version=state_version+CASE WHEN state<>$2 THEN 1 ELSE 0 END,updated_at=clock_timestamp()
        WHERE surface_key=$1`, [surface.surface_key, drifted ? 'DRIFTED' : 'ACTIVE']);
      if (drifted) {
        const context = createContext({ actorType: 'SYSTEM', actorId: 'permission-monitor',
          guildId: env.DISCORD_GUILD_ID, idempotencyKey: `permission:${surface.surface_key}:${surface.state_version}` });
        await db.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
          SELECT gen_random_uuid(),'PERMISSION_DRIFT',$1,'OPEN','CRITICAL',$2,$3
          WHERE NOT EXISTS(SELECT 1 FROM incidents WHERE incident_code='PERMISSION_DRIFT' AND scope=$1 AND state<>'RESOLVED')`,
        [surface.surface_key, { missing, exposed, unexpectedViewOverwrites, unexpectedViewRoles }, context.traceId]);
      }
    });
    results.push({ surface: surface.surface_key, drifted, missing, exposed, unexpectedViewOverwrites, unexpectedViewRoles });
  }
  return results;
}

export async function repairPermissionDrift({ client, pool, env, surfaceKey, adminRoleId,
  reason }, context) {
  const surface = (await pool.query('SELECT * FROM surfaces WHERE surface_key=$1', [surfaceKey])).rows[0];
  if (!surface) throw new QuestshopError('SURFACE_NOT_FOUND', 'ไม่พบ Surface');
  const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
  const channel = await guild.channels.fetch(surface.channel_id);
  if (!channel?.isTextBased() || channel.isDMBased()) throw new QuestshopError('SURFACE_CHANNEL_INVALID', 'ห้อง Surface ไม่ถูกต้อง');
  const bot = await guild.members.fetchMe();
  const allow = { ViewChannel: true, SendMessages: true, EmbedLinks: true, ReadMessageHistory: true };
  await channel.permissionOverwrites.edit(bot.id, allow, { reason });
  await channel.permissionOverwrites.edit(env.OWNER_ID, allow, { reason });
  if (adminRoleId) await channel.permissionOverwrites.edit(adminRoleId, allow, { reason });
  if (surface.expected_permissions?.private) {
    await channel.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false }, { reason });
    const expected = expectedPrivateAccess(guild, bot, env, adminRoleId);
    const unexpected = new Set([
      ...unexpectedPrivateViewRoles(channel, guild, expected),
      ...[...channel.permissionOverwrites.cache.values()]
        .filter((overwrite) => overwrite.allow.has(PermissionFlagsBits.ViewChannel) && !expected.has(overwrite.id))
        .map((overwrite) => overwrite.id),
    ]);
    for (const id of unexpected) {
      await channel.permissionOverwrites.edit(id, { ViewChannel: false }, { reason });
    }
  }
  const validation = (await checkPermissionDrift({ client, pool, env }))
    .find((item) => item.surface === surfaceKey);
  if (!validation || validation.drifted) throw new QuestshopError('PERMISSION_REPAIR_INCOMPLETE', 'ซ่อม Permission แล้วยังไม่ผ่าน Validation');
  await withTransaction({ pool, isolation: 'SERIALIZABLE' }, async (database) => {
    await database.query(`UPDATE incidents SET state='RESOLVED',resolved_at=clock_timestamp(),
      updated_at=clock_timestamp() WHERE incident_code='PERMISSION_DRIFT' AND scope=$1
      AND state<>'RESOLVED'`, [surfaceKey]);
    await appendAdminAudit(database, { action: 'PERMISSION_REPAIR', targetType: 'SURFACE',
      targetId: surfaceKey, actorId: context.actorId, before: surface.expected_permissions,
      after: validation, reason, context });
  });
  return validation;
}
