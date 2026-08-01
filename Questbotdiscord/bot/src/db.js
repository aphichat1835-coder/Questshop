import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { INCIDENT } from './incident-catalog.js';
import { isPersistentDatabasePath } from './storage-profile.js';

const dbPath = config.databasePath;
if (dbPath !== ':memory:') {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const LOCAL_BACKUP_ROOT = './data/backups';
const PERSISTENT_BACKUP_ROOT = '/var/data/backups';
const LOCAL_BACKUP_SLOT_PATHS = Object.freeze([
  './data/backups/questbot-slot-1.db',
  './data/backups/questbot-slot-2.db',
  './data/backups/questbot-slot-3.db',
  './data/backups/questbot-slot-4.db',
  './data/backups/questbot-slot-5.db',
  './data/backups/questbot-slot-6.db',
  './data/backups/questbot-slot-7.db',
]);
const PERSISTENT_BACKUP_SLOT_PATHS = Object.freeze([
  '/var/data/backups/questbot-slot-1.db',
  '/var/data/backups/questbot-slot-2.db',
  '/var/data/backups/questbot-slot-3.db',
  '/var/data/backups/questbot-slot-4.db',
  '/var/data/backups/questbot-slot-5.db',
  '/var/data/backups/questbot-slot-6.db',
  '/var/data/backups/questbot-slot-7.db',
]);
const LOCAL_LEGACY_MIGRATION_BACKUP_PATH = './data/backups/pre-tracker-removal.db';
const PERSISTENT_LEGACY_MIGRATION_BACKUP_PATH = '/var/data/backups/pre-tracker-removal.db';
const BACKUP_OPERATION_METHODS = Object.freeze(['backup', 'remove', 'modifiedAt']);

export const DATABASE_BACKUP_SLOT_COUNT = LOCAL_BACKUP_SLOT_PATHS.length;

function tagDatabaseError(error, incidentCode, operation) {
  const tagged = error instanceof Error ? error : new Error(String(error));
  tagged.incidentCode = incidentCode;
  tagged.bootstrapContext = {
    storageMode: config.storageProfile.mode,
    databasePathType: config.storageProfile.databasePathType,
    operation,
    errorCode: tagged.code,
  };
  return tagged;
}

function validatedSlotIndex(slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= DATABASE_BACKUP_SLOT_COUNT) {
    throw new RangeError(`Database backup slot is out of range: ${slotIndex}`);
  }
  return slotIndex;
}

export function resolveDatabaseBackupDirectory(databasePath) {
  return isPersistentDatabasePath(databasePath)
    ? PERSISTENT_BACKUP_ROOT
    : LOCAL_BACKUP_ROOT;
}

export function resolveDatabaseBackupSlotPath(databasePath, slotIndex) {
  const allowedPaths = isPersistentDatabasePath(databasePath)
    ? PERSISTENT_BACKUP_SLOT_PATHS
    : LOCAL_BACKUP_SLOT_PATHS;
  return allowedPaths[validatedSlotIndex(slotIndex)];
}

function openDatabase() {
  try {
    const database = new Database(dbPath);
    database.pragma('busy_timeout = 5000');
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    return database;
  } catch (error) {
    throw tagDatabaseError(error, INCIDENT.DATABASE_OPEN_FAILED, 'open');
  }
}

export const db = openDatabase();

const LOCAL_BACKUP_OPERATIONS = Object.freeze([
  Object.freeze({
    path: LOCAL_BACKUP_SLOT_PATHS[0],
    backup: () => db.backup('./data/backups/questbot-slot-1.db'),
    remove: () => fs.promises.rm('./data/backups/questbot-slot-1.db', { force: true }),
    modifiedAt: () => fs.statSync('./data/backups/questbot-slot-1.db').mtimeMs,
  }),
  Object.freeze({
    path: LOCAL_BACKUP_SLOT_PATHS[1],
    backup: () => db.backup('./data/backups/questbot-slot-2.db'),
    remove: () => fs.promises.rm('./data/backups/questbot-slot-2.db', { force: true }),
    modifiedAt: () => fs.statSync('./data/backups/questbot-slot-2.db').mtimeMs,
  }),
  Object.freeze({
    path: LOCAL_BACKUP_SLOT_PATHS[2],
    backup: () => db.backup('./data/backups/questbot-slot-3.db'),
    remove: () => fs.promises.rm('./data/backups/questbot-slot-3.db', { force: true }),
    modifiedAt: () => fs.statSync('./data/backups/questbot-slot-3.db').mtimeMs,
  }),
  Object.freeze({
    path: LOCAL_BACKUP_SLOT_PATHS[3],
    backup: () => db.backup('./data/backups/questbot-slot-4.db'),
    remove: () => fs.promises.rm('./data/backups/questbot-slot-4.db', { force: true }),
    modifiedAt: () => fs.statSync('./data/backups/questbot-slot-4.db').mtimeMs,
  }),
  Object.freeze({
    path: LOCAL_BACKUP_SLOT_PATHS[4],
    backup: () => db.backup('./data/backups/questbot-slot-5.db'),
    remove: () => fs.promises.rm('./data/backups/questbot-slot-5.db', { force: true }),
    modifiedAt: () => fs.statSync('./data/backups/questbot-slot-5.db').mtimeMs,
  }),
  Object.freeze({
    path: LOCAL_BACKUP_SLOT_PATHS[5],
    backup: () => db.backup('./data/backups/questbot-slot-6.db'),
    remove: () => fs.promises.rm('./data/backups/questbot-slot-6.db', { force: true }),
    modifiedAt: () => fs.statSync('./data/backups/questbot-slot-6.db').mtimeMs,
  }),
  Object.freeze({
    path: LOCAL_BACKUP_SLOT_PATHS[6],
    backup: () => db.backup('./data/backups/questbot-slot-7.db'),
    remove: () => fs.promises.rm('./data/backups/questbot-slot-7.db', { force: true }),
    modifiedAt: () => fs.statSync('./data/backups/questbot-slot-7.db').mtimeMs,
  }),
]);

const PERSISTENT_BACKUP_OPERATIONS = Object.freeze([
  Object.freeze({
    path: PERSISTENT_BACKUP_SLOT_PATHS[0],
    backup: () => db.backup('/var/data/backups/questbot-slot-1.db'),
    remove: () => fs.promises.rm('/var/data/backups/questbot-slot-1.db', { force: true }),
    modifiedAt: () => fs.statSync('/var/data/backups/questbot-slot-1.db').mtimeMs,
  }),
  Object.freeze({
    path: PERSISTENT_BACKUP_SLOT_PATHS[1],
    backup: () => db.backup('/var/data/backups/questbot-slot-2.db'),
    remove: () => fs.promises.rm('/var/data/backups/questbot-slot-2.db', { force: true }),
    modifiedAt: () => fs.statSync('/var/data/backups/questbot-slot-2.db').mtimeMs,
  }),
  Object.freeze({
    path: PERSISTENT_BACKUP_SLOT_PATHS[2],
    backup: () => db.backup('/var/data/backups/questbot-slot-3.db'),
    remove: () => fs.promises.rm('/var/data/backups/questbot-slot-3.db', { force: true }),
    modifiedAt: () => fs.statSync('/var/data/backups/questbot-slot-3.db').mtimeMs,
  }),
  Object.freeze({
    path: PERSISTENT_BACKUP_SLOT_PATHS[3],
    backup: () => db.backup('/var/data/backups/questbot-slot-4.db'),
    remove: () => fs.promises.rm('/var/data/backups/questbot-slot-4.db', { force: true }),
    modifiedAt: () => fs.statSync('/var/data/backups/questbot-slot-4.db').mtimeMs,
  }),
  Object.freeze({
    path: PERSISTENT_BACKUP_SLOT_PATHS[4],
    backup: () => db.backup('/var/data/backups/questbot-slot-5.db'),
    remove: () => fs.promises.rm('/var/data/backups/questbot-slot-5.db', { force: true }),
    modifiedAt: () => fs.statSync('/var/data/backups/questbot-slot-5.db').mtimeMs,
  }),
  Object.freeze({
    path: PERSISTENT_BACKUP_SLOT_PATHS[5],
    backup: () => db.backup('/var/data/backups/questbot-slot-6.db'),
    remove: () => fs.promises.rm('/var/data/backups/questbot-slot-6.db', { force: true }),
    modifiedAt: () => fs.statSync('/var/data/backups/questbot-slot-6.db').mtimeMs,
  }),
  Object.freeze({
    path: PERSISTENT_BACKUP_SLOT_PATHS[6],
    backup: () => db.backup('/var/data/backups/questbot-slot-7.db'),
    remove: () => fs.promises.rm('/var/data/backups/questbot-slot-7.db', { force: true }),
    modifiedAt: () => fs.statSync('/var/data/backups/questbot-slot-7.db').mtimeMs,
  }),
]);

const LOCAL_BACKUP_PROFILE = Object.freeze({
  directory: LOCAL_BACKUP_ROOT,
  slotPaths: LOCAL_BACKUP_SLOT_PATHS,
  operations: LOCAL_BACKUP_OPERATIONS,
  ensureDirectory: () => fs.mkdirSync('./data/backups', { recursive: true }),
  migrationPath: LOCAL_LEGACY_MIGRATION_BACKUP_PATH,
  removeMigration: () => fs.promises.rm('./data/backups/pre-tracker-removal.db', { force: true }),
  backupMigration: () => db.backup('./data/backups/pre-tracker-removal.db'),
});

const PERSISTENT_BACKUP_PROFILE = Object.freeze({
  directory: PERSISTENT_BACKUP_ROOT,
  slotPaths: PERSISTENT_BACKUP_SLOT_PATHS,
  operations: PERSISTENT_BACKUP_OPERATIONS,
  ensureDirectory: () => fs.mkdirSync('/var/data/backups', { recursive: true }),
  migrationPath: PERSISTENT_LEGACY_MIGRATION_BACKUP_PATH,
  removeMigration: () => fs.promises.rm('/var/data/backups/pre-tracker-removal.db', { force: true }),
  backupMigration: () => db.backup('/var/data/backups/pre-tracker-removal.db'),
});

function operationContainsDeclaredPath(operation, method) {
  return Function.prototype.toString.call(operation[method]).includes(operation.path);
}

function validateBackupProfile(profile) {
  if (
    profile.slotPaths.length !== DATABASE_BACKUP_SLOT_COUNT
    || profile.operations.length !== DATABASE_BACKUP_SLOT_COUNT
  ) {
    throw new Error(`Backup profile ${profile.directory} has an invalid slot count`);
  }
  for (const [index, operation] of profile.operations.entries()) {
    if (operation.path !== profile.slotPaths[index]) {
      throw new Error(`Backup operation ${index} does not match its fixed slot path`);
    }
    for (const method of BACKUP_OPERATION_METHODS) {
      if (!operationContainsDeclaredPath(operation, method)) {
        throw new Error(`Backup operation ${index}.${method} targets a different fixed path`);
      }
    }
  }
  return profile;
}

validateBackupProfile(LOCAL_BACKUP_PROFILE);
validateBackupProfile(PERSISTENT_BACKUP_PROFILE);

function resolveBackupProfile(directory) {
  if (directory == null) return null;
  if (directory === LOCAL_BACKUP_ROOT) return LOCAL_BACKUP_PROFILE;
  if (directory === PERSISTENT_BACKUP_ROOT) return PERSISTENT_BACKUP_PROFILE;
  throw new Error(`Unsupported database backup directory: ${directory}`);
}

const backupDirectory = config.storageProfile.backupDirectory
  ?? (dbPath === ':memory:' ? null : resolveDatabaseBackupDirectory(dbPath));
const backupProfile = resolveBackupProfile(backupDirectory);

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_runners (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id          TEXT NOT NULL,
      guild_id          TEXT,
      channel_id        TEXT NOT NULL,
      account_id        TEXT NOT NULL,
      username          TEXT NOT NULL,
      token_ciphertext  TEXT NOT NULL,
      token_iv          TEXT NOT NULL,
      token_tag         TEXT NOT NULL,
      token_salt        TEXT NOT NULL,
      next_check_at     TEXT,
      last_check_at     TEXT,
      last_error        TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_id, account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_runners_owner
      ON scheduled_runners(owner_id);

    CREATE TABLE IF NOT EXISTS runtime_leases (
      name       TEXT PRIMARY KEY,
      holder     TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
} catch (error) {
  throw tagDatabaseError(error, INCIDENT.DATABASE_MIGRATION_FAILED, 'schema-bootstrap');
}

let legacyMigrationBackupPath = null;

function ensureBackupDirectory() {
  backupProfile?.ensureDirectory();
}

function backupOperations() {
  return backupProfile?.operations ?? [];
}

function tableExists(name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function existingLegacyTables() {
  const tables = [];
  if (tableExists('quest_logs')) tables.push('quest_logs');
  if (tableExists('guild_settings')) tables.push('guild_settings');
  if (tableExists('quests')) tables.push('quests');
  return tables;
}

function dropLegacyTables(existing) {
  if (existing.includes('quest_logs')) db.exec('DROP TABLE IF EXISTS quest_logs');
  if (existing.includes('guild_settings')) db.exec('DROP TABLE IF EXISTS guild_settings');
  if (existing.includes('quests')) db.exec('DROP TABLE IF EXISTS quests');
}

export async function backupDatabaseSlot(slotIndex) {
  if (!backupProfile) throw new Error('Database backup is unavailable for in-memory storage');
  ensureBackupDirectory();
  const operation = backupOperations()[validatedSlotIndex(slotIndex)];
  await operation.backup();
  return operation.path;
}

export async function clearInactiveDatabaseBackupSlots(retention) {
  const keep = Math.max(1, Math.min(DATABASE_BACKUP_SLOT_COUNT, retention));
  await Promise.all(backupOperations().slice(keep).map((operation) => operation.remove()));
}

export async function clearAllDatabaseBackupSlots() {
  await Promise.all(backupOperations().map((operation) => operation.remove()));
}

export function getLatestDatabaseBackupAt() {
  if (!config.databaseBackupEnabled || !backupProfile) return null;
  let latest = 0;
  for (const operation of backupOperations()) {
    try {
      latest = Math.max(latest, operation.modifiedAt());
    } catch {}
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

async function createLegacyMigrationBackup() {
  if (!backupProfile) return null;
  ensureBackupDirectory();
  await backupProfile.removeMigration();
  await backupProfile.backupMigration();
  return backupProfile.migrationPath;
}

async function migrateLegacyTracker() {
  const existing = existingLegacyTables();
  if (!existing.length) return;

  legacyMigrationBackupPath = await createLegacyMigrationBackup();
  db.transaction(() => {
    dropLegacyTables(existing);
    db.pragma('user_version = 2');
  })();

  console.log(
    `🧹 Removed legacy Quest Tracker tables: ${existing.join(', ')}`
      + (legacyMigrationBackupPath ? ` · backup: ${legacyMigrationBackupPath}` : ''),
  );
}

try {
  await migrateLegacyTracker();
} catch (error) {
  throw tagDatabaseError(error, INCIDENT.DATABASE_MIGRATION_FAILED, 'legacy-tracker-migration');
}

const acquireRuntimeLeaseTransaction = db.transaction((name, holder, ttlMs, now) => {
  db.prepare('DELETE FROM runtime_leases WHERE expires_at <= ?').run(now);
  const existing = db.prepare('SELECT holder FROM runtime_leases WHERE name = ?').get(name);
  if (existing && existing.holder !== holder) return false;
  db.prepare(`
    INSERT INTO runtime_leases (name, holder, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      holder = excluded.holder,
      expires_at = excluded.expires_at
  `).run(name, holder, now + ttlMs);
  return true;
});

export function acquireRuntimeLease(name, holder, ttlMs = 90_000) {
  if (!name || !holder) throw new TypeError('Runtime lease name and holder are required');
  return acquireRuntimeLeaseTransaction.immediate(name, holder, ttlMs, Date.now());
}

export function renewRuntimeLease(name, holder, ttlMs = 90_000) {
  return db.prepare(`
    UPDATE runtime_leases
    SET expires_at = ?
    WHERE name = ? AND holder = ?
  `).run(Date.now() + ttlMs, name, holder).changes > 0;
}

export function releaseRuntimeLease(name, holder) {
  return db.prepare(
    'DELETE FROM runtime_leases WHERE name = ? AND holder = ?',
  ).run(name, holder).changes > 0;
}

export function closeDatabase() {
  if (db.open) db.close();
}

export function getDatabasePath() {
  return dbPath;
}

export function getDatabaseBackupDirectory() {
  return backupProfile?.directory ?? null;
}

export function getLegacyMigrationBackupPath() {
  return legacyMigrationBackupPath;
}
