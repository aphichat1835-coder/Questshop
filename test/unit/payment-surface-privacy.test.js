import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { assertSensitiveSurfacePrivacy } from '../../src/discord/surfaces/setup.js';

function permissions(...allowed) {
  return { has: (flag) => allowed.includes(flag) };
}

function makeChannel({ everyoneVisible = false, staffVisible = false, individualVisible = false } = {}) {
  const everyone = { id: 'guild', name: '@everyone', permissions: permissions() };
  const admin = { id: 'admin-role', name: 'Admin', permissions: permissions(PermissionFlagsBits.Administrator) };
  const staff = { id: 'staff-role', name: 'Staff', permissions: permissions() };
  const roles = new Map([[everyone.id, everyone], [admin.id, admin], [staff.id, staff]]);
  const visibility = new Map([
    [everyone.id, permissions(...(everyoneVisible ? [PermissionFlagsBits.ViewChannel] : []))],
    [admin.id, permissions(PermissionFlagsBits.ViewChannel)],
    [staff.id, permissions(...(staffVisible ? [PermissionFlagsBits.ViewChannel] : []))],
  ]);
  const overwrites = new Map();
  if (individualVisible) overwrites.set('random-user', {
    id: 'random-user', allow: permissions(PermissionFlagsBits.ViewChannel),
  });
  return {
    guild: { roles: { everyone, cache: roles } },
    client: { user: { id: 'bot-user' }, questshop: { env: { OWNER_ID: 'owner-user' } } },
    permissionOverwrites: { cache: overwrites },
    permissionsFor: (target) => visibility.get(target.id) ?? permissions(),
  };
}

test('non-sensitive surfaces do not impose payment-log privacy policy', () => {
  assert.equal(assertSensitiveSurfacePrivacy(null, 'QUEST_AUTO'), true);
});

test('LOG_PAYMENTS rejects a channel visible to everyone', () => {
  assert.throws(() => assertSensitiveSurfacePrivacy(makeChannel({ everyoneVisible: true }), 'LOG_PAYMENTS'),
    (error) => error.code === 'SURFACE_CHANNEL_INVALID' && /@everyone/.test(error.message));
});

test('LOG_PAYMENTS rejects visibility granted to a non-Administrator role', () => {
  assert.throws(() => assertSensitiveSurfacePrivacy(makeChannel({ staffVisible: true }), 'LOG_PAYMENTS'),
    (error) => error.code === 'SURFACE_CHANNEL_INVALID' && /Staff/.test(error.message));
});

test('LOG_PAYMENTS rejects explicit visibility granted to an arbitrary member', () => {
  assert.throws(() => assertSensitiveSurfacePrivacy(makeChannel({ individualVisible: true }), 'LOG_PAYMENTS'),
    (error) => error.code === 'SURFACE_CHANNEL_INVALID' && /รายบุคคล/.test(error.message));
});

test('LOG_PAYMENTS accepts a private channel visible only through Administrator access', () => {
  assert.equal(assertSensitiveSurfacePrivacy(makeChannel(), 'LOG_PAYMENTS'), true);
});
