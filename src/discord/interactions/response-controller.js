import { MessageFlags } from 'discord.js';
import { QuestshopError } from '../../shared/errors.js';

export const ACKNOWLEDGEMENT = Object.freeze({
  NONE: 'NONE',
  REPLY: 'reply',
  DEFER_REPLY: 'deferReply',
  UPDATE: 'update',
  DEFER_UPDATE: 'deferUpdate',
  MODAL: 'showModal',
});

const INITIAL_METHODS = Object.freeze([
  ACKNOWLEDGEMENT.REPLY,
  ACKNOWLEDGEMENT.DEFER_REPLY,
  ACKNOWLEDGEMENT.UPDATE,
  ACKNOWLEDGEMENT.DEFER_UPDATE,
  ACKNOWLEDGEMENT.MODAL,
]);

export function acknowledgementOf(interaction) {
  return interaction.__questshopAcknowledgement ?? ACKNOWLEDGEMENT.NONE;
}

export function installResponseController(interaction, { onAcknowledged = () => {} } = {}) {
  for (const method of INITIAL_METHODS) {
    if (typeof interaction[method] !== 'function') continue;
    const original = interaction[method].bind(interaction);
    interaction[method] = async (...args) => {
      const current = acknowledgementOf(interaction);
      if (current !== ACKNOWLEDGEMENT.NONE) {
        if (current === method) return null;
        throw new QuestshopError('INTERACTION_ALREADY_ACKNOWLEDGED', 'Interaction ถูกตอบรับแล้ว');
      }
      const normalized = args.map((value, index) => {
        if (index !== 0 || !value || typeof value !== 'object' || value.ephemeral !== true) return value;
        const normalizedOptions = { ...value, flags: value.flags ?? MessageFlags.Ephemeral };
        delete normalizedOptions.ephemeral;
        return normalizedOptions;
      });
      const result = await original(...normalized);
      interaction.__questshopAcknowledgement = method;
      onAcknowledged(method);
      return result;
    };
  }
}

export async function acknowledgeByContract(interaction, response) {
  if (response === 'UPDATE') return interaction.deferUpdate();
  if (response === 'REPLY') return interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return null;
}

export function ephemeralResponse(payload = {}) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}
