import { v7 as uuidv7 } from 'uuid';
import { createEncryptedBackup } from '../adapters/s3/backup.js';
import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { createS3Client } from '../adapters/s3/client.js';

export async function pruneExpiredBackups({ env, pool }) {
  const expired = (await pool.query(`SELECT id,object_key,manifest FROM backup_runs
    WHERE state='VERIFIED' AND completed_at<clock_timestamp()-interval '30 days'
      AND object_key IS NOT NULL ORDER BY completed_at LIMIT 100`)).rows;
  if (!expired.length) return 0;
  const s3 = createS3Client(env);
  const objects = expired.flatMap((row) => [
    { Key: row.object_key, ...(row.manifest?.objectVersion ? { VersionId: row.manifest.objectVersion } : {}) },
    { Key: row.manifest?.manifestKey ?? `${row.object_key}.json` },
  ]);
  const result = await s3.send(new DeleteObjectsCommand({ Bucket: env.S3_BUCKET,
    Delete: { Objects: objects, Quiet: false } }));
  if (result.Errors?.length) throw Object.assign(new Error('backup retention object deletion failed'), {
    code: 'BACKUP_RETENTION_DELETE_FAILED', details: result.Errors.map((error) => error.Code),
  });
  await pool.query(`UPDATE backup_runs SET state='EXPIRED',expired_at=clock_timestamp()
    WHERE id=ANY($1::uuid[]) AND state='VERIFIED'`, [expired.map((row) => row.id)]);
  return expired.length;
}

export async function runScheduledBackup({ env, pool }) {
  if (env.BACKUP_ENABLED === false || (env.BACKUP_ENABLED == null && env.NODE_ENV !== 'production')) return false;
  try { await pruneExpiredBackups({ env, pool }); }
  catch (error) {
    await pool.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
      VALUES(gen_random_uuid(),'BACKUP_RETENTION_FAILED','S3','OPEN','ERROR',$1,gen_random_uuid())
      ON CONFLICT (incident_code,scope) WHERE state<>'RESOLVED' DO UPDATE SET
        evidence=EXCLUDED.evidence,updated_at=clock_timestamp()`,
    [{ errorCode: error.code ?? error.name }]);
    throw error;
  }
  const due = (await pool.query(`SELECT
    (clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::time >= time '03:00' AS after_three,
    NOT EXISTS(SELECT 1 FROM backup_runs WHERE backup_type='DAILY' AND state='VERIFIED'
      AND (completed_at AT TIME ZONE 'Asia/Bangkok')::date=(clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date) AS missing,
    (SELECT max(version) FROM schema_migrations)::integer AS schema_version`)).rows[0];
  if (!due.after_three || !due.missing) return false;
  const id = uuidv7();
  await pool.query(`INSERT INTO backup_runs(id,backup_type,state,git_sha,encryption_key_version,manifest)
    VALUES($1,'DAILY','STARTED',$2,$3,$4)`, [id, env.GIT_SHA,
    env.BACKUP_ENCRYPTION_KEYS_JSON.current, { reason: 'daily' }]);
  try {
    const backup = await createEncryptedBackup({ env, schemaVersion: due.schema_version, reason: 'daily', backupId: id });
    await pool.query(`UPDATE backup_runs SET state='VERIFIED',object_key=$2,checksum=$3,size_bytes=$4,
      schema_version=$5,manifest=$6,completed_at=clock_timestamp() WHERE id=$1`,
    [id, backup.objectKey, backup.checksum, backup.sizeBytes, due.schema_version, backup]);
  } catch (error) {
    await pool.query(`UPDATE backup_runs SET state='FAILED',error_code=$2,completed_at=clock_timestamp()
      WHERE id=$1`, [id, error.code ?? error.name]);
    await pool.query(`INSERT INTO incidents(id,incident_code,scope,state,severity,evidence,trace_id)
      VALUES(gen_random_uuid(),'BACKUP_FAILED','DAILY','OPEN','CRITICAL',$1,gen_random_uuid())`,
    [{ errorCode: error.code ?? error.name }]);
    throw error;
  }
  return true;
}
