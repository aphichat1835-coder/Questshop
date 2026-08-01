import { db } from './db.js';

const LEASE_NAMES = Object.freeze({
  all: 'bot-runtime',
  control: 'bot-control',
});
const LEGACY_WORKER_LEASE = 'quest-worker';
const WORKER_LEASE_PREFIX = `${LEGACY_WORKER_LEASE}:`;

function requireRole(role) {
  if (!['all', 'control', 'worker'].includes(role)) {
    throw new Error(`Unknown process role: ${role}`);
  }
  return role;
}

function requireHolder(holder) {
  if (typeof holder !== 'string' || holder.trim() === '') {
    throw new TypeError('Process role lease holder is required');
  }
  return holder;
}

function isWorkerLeaseName(name) {
  return name === LEGACY_WORKER_LEASE || name.startsWith(WORKER_LEASE_PREFIX);
}

function workerLeaseName(holder) {
  return `${WORKER_LEASE_PREFIX}${requireHolder(holder)}`;
}

function topologyLeaseName(role, holder = null) {
  requireRole(role);
  if (role === 'worker') return holder ? workerLeaseName(holder) : LEGACY_WORKER_LEASE;
  return LEASE_NAMES[role];
}

function conflictsWithRole(role, lease, holder) {
  if (role === 'all') {
    return lease.name === LEASE_NAMES.all
      ? lease.holder !== holder
      : lease.name === LEASE_NAMES.control || isWorkerLeaseName(lease.name);
  }
  if (role === 'control') {
    if (lease.name === LEASE_NAMES.all) return true;
    return lease.name === LEASE_NAMES.control && lease.holder !== holder;
  }
  if (lease.name === LEASE_NAMES.all) return true;
  if (lease.name === LEGACY_WORKER_LEASE) return lease.holder !== holder;
  return false;
}

const acquireTopologyLease = db.transaction((role, holder, ttlMs, now) => {
  const leaseName = topologyLeaseName(role, holder);
  db.prepare('DELETE FROM runtime_leases WHERE expires_at <= ?').run(now);
  const active = db.prepare(`
    SELECT name, holder FROM runtime_leases
    WHERE expires_at > ?
  `).all(now);
  if (active.some((lease) => conflictsWithRole(role, lease, holder))) return false;

  db.prepare(`
    INSERT INTO runtime_leases (name, holder, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      holder = excluded.holder,
      expires_at = excluded.expires_at
  `).run(leaseName, holder, now + ttlMs);
  return true;
});

export function processLeaseName(role, holder = null) {
  return topologyLeaseName(role, holder);
}

export function acquireProcessRoleLease(role, holder, ttlMs = 90_000) {
  requireHolder(holder);
  return acquireTopologyLease.immediate(requireRole(role), holder, ttlMs, Date.now());
}

export function renewProcessRoleLease(role, holder, ttlMs = 90_000) {
  return db.prepare(`
    UPDATE runtime_leases
    SET expires_at = ?
    WHERE name = ? AND holder = ?
  `).run(
    Date.now() + ttlMs,
    topologyLeaseName(role, holder),
    requireHolder(holder),
  ).changes > 0;
}

export function releaseProcessRoleLease(role, holder) {
  return db.prepare(
    'DELETE FROM runtime_leases WHERE name = ? AND holder = ?',
  ).run(topologyLeaseName(role, holder), requireHolder(holder)).changes > 0;
}

export function isProcessRoleActive(role, now = Date.now()) {
  requireRole(role);
  if (role === 'worker') {
    return Boolean(db.prepare(`
      SELECT 1 FROM runtime_leases
      WHERE (name = ? OR name LIKE ?) AND expires_at > ?
      LIMIT 1
    `).get(LEGACY_WORKER_LEASE, `${WORKER_LEASE_PREFIX}%`, now));
  }
  return Boolean(db.prepare(`
    SELECT 1 FROM runtime_leases
    WHERE name = ? AND expires_at > ?
  `).get(LEASE_NAMES[role], now));
}

export function listActiveProcessRoles(now = Date.now()) {
  const roles = [];
  if (isProcessRoleActive('all', now)) roles.push('all');
  if (isProcessRoleActive('control', now)) roles.push('control');
  if (isProcessRoleActive('worker', now)) roles.push('worker');
  return roles;
}

export function listActiveWorkerHolders(now = Date.now()) {
  return db.prepare(`
    SELECT holder FROM runtime_leases
    WHERE (name = ? OR name LIKE ?) AND expires_at > ?
    ORDER BY holder
  `).all(LEGACY_WORKER_LEASE, `${WORKER_LEASE_PREFIX}%`, now)
    .map((row) => row.holder);
}

export function clearProcessRoleLeasesForTests() {
  db.prepare(`
    DELETE FROM runtime_leases
    WHERE name IN (?, ?) OR name = ? OR name LIKE ?
  `).run(
    LEASE_NAMES.all,
    LEASE_NAMES.control,
    LEGACY_WORKER_LEASE,
    `${WORKER_LEASE_PREFIX}%`,
  );
}
