import { db } from './db.js';
import { encryptRunnerToken } from './runner-token-crypto.js';

export { decryptRunnerToken, encryptRunnerToken } from './runner-token-crypto.js';

export function createScheduledRunner({
  ownerId,
  guildId,
  channelId,
  accountId,
  username,
  token,
  secret,
  nextCheckAt = null,
}) {
  const encrypted = encryptRunnerToken(token, secret, ownerId, accountId);
  const info = db.prepare(`
    INSERT INTO scheduled_runners (
      owner_id, guild_id, channel_id, account_id, username,
      token_ciphertext, token_iv, token_tag, token_salt, next_check_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ownerId,
    guildId ?? null,
    channelId,
    accountId,
    username,
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.tag,
    encrypted.salt,
    nextCheckAt,
  );
  return getScheduledRunner(info.lastInsertRowid);
}

export function getScheduledRunner(id) {
  return db.prepare('SELECT * FROM scheduled_runners WHERE id = ?').get(id) ?? null;
}

export function findScheduledRunner(ownerId, accountId) {
  return db.prepare(
    'SELECT * FROM scheduled_runners WHERE owner_id = ? AND account_id = ?',
  ).get(ownerId, accountId) ?? null;
}

export function findAnyScheduledRunner(accountId) {
  return db.prepare(
    'SELECT * FROM scheduled_runners WHERE account_id = ? ORDER BY id ASC LIMIT 1',
  ).get(accountId) ?? null;
}

export function listScheduledRunners(ownerId = null) {
  if (ownerId == null) {
    return db.prepare('SELECT * FROM scheduled_runners ORDER BY id ASC').all();
  }
  return db.prepare(
    'SELECT * FROM scheduled_runners WHERE owner_id = ? ORDER BY id ASC',
  ).all(ownerId);
}

export function updateScheduledRunner(id, {
  username,
  channelId,
  nextCheckAt,
  lastCheckAt,
  lastError,
} = {}) {
  const fields = [`updated_at = datetime('now')`];
  const values = [];

  if (username !== undefined)    { fields.push('username = ?');      values.push(username); }
  if (channelId !== undefined)   { fields.push('channel_id = ?');    values.push(channelId); }
  if (nextCheckAt !== undefined) { fields.push('next_check_at = ?'); values.push(nextCheckAt); }
  if (lastCheckAt !== undefined) { fields.push('last_check_at = ?'); values.push(lastCheckAt); }
  if (lastError !== undefined)   { fields.push('last_error = ?');    values.push(lastError); }

  values.push(id);
  db.prepare(`UPDATE scheduled_runners SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getScheduledRunner(id);
}

export function deleteScheduledRunner(id, ownerId = null) {
  const sql = ownerId == null
    ? 'DELETE FROM scheduled_runners WHERE id = ?'
    : 'DELETE FROM scheduled_runners WHERE id = ? AND owner_id = ?';
  const args = ownerId == null ? [id] : [id, ownerId];
  return db.prepare(sql).run(...args).changes > 0;
}

export function deleteAllScheduledRunners(ownerId) {
  return db.prepare('DELETE FROM scheduled_runners WHERE owner_id = ?').run(ownerId).changes;
}
