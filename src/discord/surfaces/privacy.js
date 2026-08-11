import { PermissionFlagsBits, OverwriteType } from 'discord.js';

const viewChannel = PermissionFlagsBits.ViewChannel;

function canView(channel, subject) {
  return Boolean(channel.permissionsFor(subject)?.has(viewChannel));
}

function allowedHumanIds({ guild, adminRoleId, ownerId }) {
  return new Set([guild.ownerId, ownerId, adminRoleId].filter(Boolean).map(String));
}

export function inspectPrivateSurface({ channel, guild, botMember, adminRoleId, ownerId }) {
  const allowed = allowedHumanIds({ guild, adminRoleId, ownerId });
  const everyone = guild.roles.everyone;
  if (canView(channel, everyone)) return { safe: false, reason: 'EVERYONE_CAN_VIEW' };
  if (adminRoleId) {
    const adminRole = guild.roles.cache.get(adminRoleId);
    if (!adminRole || !canView(channel, adminRole)) return { safe: false, reason: 'ADMIN_ROLE_CANNOT_VIEW' };
  }
  for (const role of guild.roles.cache.values()) {
    // Managed integration roles can still be assigned to people. They are
    // safe to skip only when the bot itself holds them.
    if (role.id === everyone.id || allowed.has(role.id) || botMember?.roles?.cache?.has(role.id)) continue;
    if (canView(channel, role)) return { safe: false, reason: 'UNEXPECTED_ROLE_CAN_VIEW', subjectId: role.id };
  }
  for (const overwrite of channel.permissionOverwrites?.cache?.values?.() ?? []) {
    if (overwrite.type !== OverwriteType.Member || allowed.has(overwrite.id) || overwrite.id === botMember?.id) continue;
    if (overwrite.allow?.has(viewChannel)) return { safe: false, reason: 'UNEXPECTED_MEMBER_CAN_VIEW', subjectId: overwrite.id };
  }
  return { safe: true };
}

export function assertPrivateSurface(input) {
  const result = inspectPrivateSurface(input);
  if (!result.safe) {
    const error = Object.assign(new Error('Private surface visibility is unsafe'), {
      code: 'PRIVATE_SURFACE_EXPOSED', privacy: result,
    });
    throw error;
  }
  return result;
}
