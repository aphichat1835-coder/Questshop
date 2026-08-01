import { config } from './config.js';

export function isOwner(interaction) {
  return interaction.user.id === config.ownerId;
}

export function isAdmin(interaction) {
  if (isOwner(interaction)) return true;
  return interaction.member?.permissions?.has('Administrator') ?? false;
}

export function isManager(interaction) {
  if (isAdmin(interaction)) return true;
  if (!config.managerRoleId) return false;
  return interaction.member?.roles?.cache?.has(config.managerRoleId) ?? false;
}
