import { db } from '../db.js';

export const DEFAULT_SCHEDULED_CLAIM_TTL_MS = 90_000;

function normalizeScheduleId(value) {
  const scheduleId = Number(value);
  if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
    throw new TypeError(`Scheduled runner claim requires a positive integer id: ${value}`);
  }
  return scheduleId;
}

function requireHolder(holder) {
  if (typeof holder !== 'string' || holder.trim() === '') {
    throw new TypeError('Scheduled runner claim holder is required');
  }
  return holder;
}

function normalizeTtl(ttlMs) {
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl < 1_000) {
    throw new RangeError('Scheduled runner claim TTL must be at least 1000ms');
  }
  return Math.floor(ttl);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_runner_claims (
    schedule_id      INTEGER PRIMARY KEY,
    holder           TEXT NOT NULL,
    lease_expires_at INTEGER NOT NULL,
    claimed_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_runner_claims_expiry
    ON scheduled_runner_claims(lease_expires_at);
  CREATE INDEX IF NOT EXISTS idx_scheduled_runner_claims_holder
    ON scheduled_runner_claims(holder, lease_expires_at);
`);

const acquireClaimTransaction = db.transaction((scheduleId, holder, ttlMs, now) => {
  db.prepare('DELETE FROM scheduled_runner_claims WHERE lease_expires_at <= ?').run(now);
  const iso = new Date(now).toISOString();
  const result = db.prepare(`
    INSERT INTO scheduled_runner_claims (
      schedule_id, holder, lease_expires_at, claimed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(schedule_id) DO UPDATE SET
      holder = excluded.holder,
      lease_expires_at = excluded.lease_expires_at,
      updated_at = excluded.updated_at
    WHERE scheduled_runner_claims.holder = excluded.holder
       OR scheduled_runner_claims.lease_expires_at <= ?
  `).run(scheduleId, holder, now + ttlMs, iso, iso, now);
  if (result.changes === 0) return false;
  return db.prepare(`
    SELECT holder FROM scheduled_runner_claims
    WHERE schedule_id = ? AND lease_expires_at > ?
  `).get(scheduleId, now)?.holder === holder;
});

const listAllClaims = db.prepare(`
  SELECT schedule_id, holder, lease_expires_at, claimed_at, updated_at
  FROM scheduled_runner_claims
  ORDER BY schedule_id
`);
const listActiveClaims = db.prepare(`
  SELECT schedule_id, holder, lease_expires_at, claimed_at, updated_at
  FROM scheduled_runner_claims
  WHERE lease_expires_at > ?
  ORDER BY schedule_id
`);
const listClaimsByHolder = db.prepare(`
  SELECT schedule_id, holder, lease_expires_at, claimed_at, updated_at
  FROM scheduled_runner_claims
  WHERE holder = ?
  ORDER BY schedule_id
`);
const listActiveClaimsByHolder = db.prepare(`
  SELECT schedule_id, holder, lease_expires_at, claimed_at, updated_at
  FROM scheduled_runner_claims
  WHERE holder = ? AND lease_expires_at > ?
  ORDER BY schedule_id
`);

export function acquireScheduledRunnerClaim(
  scheduleId,
  holder,
  ttlMs = DEFAULT_SCHEDULED_CLAIM_TTL_MS,
  now = Date.now(),
) {
  return acquireClaimTransaction.immediate(
    normalizeScheduleId(scheduleId),
    requireHolder(holder),
    normalizeTtl(ttlMs),
    now,
  );
}

export function renewScheduledRunnerClaim(
  scheduleId,
  holder,
  ttlMs = DEFAULT_SCHEDULED_CLAIM_TTL_MS,
  now = Date.now(),
) {
  const iso = new Date(now).toISOString();
  return db.prepare(`
    UPDATE scheduled_runner_claims
    SET lease_expires_at = ?, updated_at = ?
    WHERE schedule_id = ? AND holder = ? AND lease_expires_at > ?
  `).run(
    now + normalizeTtl(ttlMs),
    iso,
    normalizeScheduleId(scheduleId),
    requireHolder(holder),
    now,
  ).changes > 0;
}

export function releaseScheduledRunnerClaim(scheduleId, holder) {
  return db.prepare(`
    DELETE FROM scheduled_runner_claims
    WHERE schedule_id = ? AND holder = ?
  `).run(normalizeScheduleId(scheduleId), requireHolder(holder)).changes > 0;
}

export function releaseScheduledRunnerClaimsByHolder(holder) {
  return db.prepare(
    'DELETE FROM scheduled_runner_claims WHERE holder = ?',
  ).run(requireHolder(holder)).changes;
}

export function getScheduledRunnerClaim(scheduleId, now = Date.now()) {
  return db.prepare(`
    SELECT schedule_id, holder, lease_expires_at, claimed_at, updated_at
    FROM scheduled_runner_claims
    WHERE schedule_id = ? AND lease_expires_at > ?
  `).get(normalizeScheduleId(scheduleId), now) ?? null;
}

export function listScheduledRunnerClaims({ holder = null, activeOnly = true, now = Date.now() } = {}) {
  if (holder != null) {
    const normalizedHolder = requireHolder(holder);
    return activeOnly
      ? listActiveClaimsByHolder.all(normalizedHolder, now)
      : listClaimsByHolder.all(normalizedHolder);
  }
  return activeOnly ? listActiveClaims.all(now) : listAllClaims.all();
}

export function pruneExpiredScheduledRunnerClaims(now = Date.now()) {
  return db.prepare(
    'DELETE FROM scheduled_runner_claims WHERE lease_expires_at <= ?',
  ).run(now).changes;
}

export function clearScheduledRunnerClaimsForTests() {
  db.prepare('DELETE FROM scheduled_runner_claims').run();
}
