import fs from 'node:fs';
import path from 'node:path';

const LOCAL_DATABASE_PATH = './data/quests.db';
const PERSISTENT_DATABASE_PATH = '/var/data/quests.db';
const LOCAL_BACKUP_DIRECTORY = './data/backups';
const PERSISTENT_BACKUP_DIRECTORY = '/var/data/backups';

function isHostedEnvironment(env) {
  return Boolean(
    env.RENDER
    || env.RENDER_SERVICE_ID
    || env.RENDER_SERVICE_NAME
    || env.RENDER_INSTANCE_ID,
  );
}

function canUsePersistentDataRoot(fsApi) {
  try {
    if (!fsApi.statSync('/var/data').isDirectory()) return false;
    fsApi.accessSync('/var/data', fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function isPersistentDatabasePath(databasePath) {
  if (databasePath === ':memory:' || !path.isAbsolute(databasePath)) return false;
  const normalized = path.resolve(databasePath);
  return normalized === '/var/data' || normalized.startsWith('/var/data/');
}

function profileForPath(databasePath, hosted) {
  if (databasePath === ':memory:') {
    return {
      mode: 'memory',
      databasePath,
      databasePathType: 'memory',
      backupDirectory: null,
      backupEnabled: false,
      durability: 'none',
      durabilityVerified: false,
      warning: 'In-memory database is discarded when the process stops.',
    };
  }

  if (isPersistentDatabasePath(databasePath)) {
    return {
      mode: 'persistent-candidate',
      databasePath,
      databasePathType: 'persistent',
      backupDirectory: PERSISTENT_BACKUP_DIRECTORY,
      backupEnabled: true,
      durability: 'candidate',
      durabilityVerified: false,
      warning: 'Persistent durability must be verified by a controlled restart test.',
    };
  }

  return {
    mode: hosted ? 'hosted-ephemeral' : 'local-development',
    databasePath,
    databasePathType: 'local',
    backupDirectory: LOCAL_BACKUP_DIRECTORY,
    backupEnabled: true,
    durability: hosted ? 'not-persistent' : 'local',
    durabilityVerified: false,
    warning: hosted
      ? 'No persistent mount was detected; database and backups may disappear after redeploy.'
      : null,
  };
}

export function resolveStorageProfile({ env = process.env, fsApi = fs } = {}) {
  const explicitPath = env.DATABASE_PATH?.trim();
  const hosted = isHostedEnvironment(env);
  if (explicitPath) return Object.freeze(profileForPath(explicitPath, hosted));

  const automaticPath = canUsePersistentDataRoot(fsApi)
    ? PERSISTENT_DATABASE_PATH
    : LOCAL_DATABASE_PATH;
  return Object.freeze(profileForPath(automaticPath, hosted));
}

export const STORAGE_PATHS = Object.freeze({
  localDatabase: LOCAL_DATABASE_PATH,
  persistentDatabase: PERSISTENT_DATABASE_PATH,
  localBackups: LOCAL_BACKUP_DIRECTORY,
  persistentBackups: PERSISTENT_BACKUP_DIRECTORY,
});
