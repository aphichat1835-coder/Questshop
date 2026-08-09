import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPrivateSurface } from '../../src/discord/surfaces/privacy.js';

function subject(id, visible) { return { id, visible }; }
function channel({ everyone = false, admin = true, unexpectedRole = false, unexpectedMember = false } = {}) {
  const roles = new Map([
    ['everyone', subject('everyone', everyone)], ['admin', subject('admin', admin)],
    ['bot-role', { id: 'bot-role', managed: true, visible: true }],
    ['other', subject('other', unexpectedRole)],
  ]);
  return {
    permissionsFor(value) { return { has: () => Boolean(value.visible) }; },
    permissionOverwrites: { cache: new Map(unexpectedMember ? [['member', { id: 'member', type: 1,
      allow: { has: () => true } }]] : []) },
    guild: { roles: { everyone: roles.get('everyone'), cache: roles }, ownerId: 'owner' },
  };
}

function inspect(options) {
  const value = channel(options);
  return inspectPrivateSurface({ channel: value, guild: value.guild, botMember: { id: 'bot', roles: { cache: new Map() } },
    adminRoleId: 'admin', ownerId: 'owner' });
}

test('private payment surface allows only the configured human access set', () => {
  assert.deepEqual(inspect(), { safe: true });
  assert.equal(inspect({ everyone: true }).reason, 'EVERYONE_CAN_VIEW');
  assert.equal(inspect({ unexpectedRole: true }).reason, 'UNEXPECTED_ROLE_CAN_VIEW');
  assert.equal(inspect({ unexpectedMember: true }).reason, 'UNEXPECTED_MEMBER_CAN_VIEW');
});
