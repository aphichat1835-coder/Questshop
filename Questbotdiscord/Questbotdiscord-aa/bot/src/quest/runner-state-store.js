import { db } from '../db.js';

export const RUNNER_STATE = Object.freeze({
  QUEUED: 'QUEUED',
  AUTHENTICATING: 'AUTHENTICATING',
  FETCHING_QUESTS: 'FETCHING_QUESTS',
  ENROLLING: 'ENROLLING',
  VERIFYING_ENROLLMENT: 'VERIFYING_ENROLLMENT',
  RUNNING_PROGRESS: 'RUNNING_PROGRESS',
  VERIFYING_PROGRESS: 'VERIFYING_PROGRESS',
  VERIFYING_COMPLETION: 'VERIFYING_COMPLETION',
  CLAIMING: 'CLAIMING',
  VERIFYING_CLAIM: 'VERIFYING_CLAIM',
  WAITING_RATE_LIMIT: 'WAITING_RATE_LIMIT',
  WAITING_ENROLLMENT: 'WAITING_ENROLLMENT',
  WAITING_RETRY: 'WAITING_RETRY',
  WAITING_SCHEDULE: 'WAITING_SCHEDULE',
  RECOVERING: 'RECOVERING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

export const RUNNER_MUTATION_KIND = Object.freeze({
  ENROLL: 'ENROLL',
  VIDEO_PROGRESS: 'VIDEO_PROGRESS',
  HEARTBEAT: 'HEARTBEAT',
  CLAIM: 'CLAIM',
});

export const RUNNER_MUTATION_STATUS = Object.freeze({
  NONE: 'NONE',
  PREPARED: 'PREPARED',
  IN_FLIGHT: 'IN_FLIGHT',
  ACCEPTED: 'ACCEPTED',
  UNCERTAIN: 'UNCERTAIN',
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
});

export const RUNNER_ERROR_CATEGORY = Object.freeze({
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  API_4XX: 'API_4XX',
  API_5XX: 'API_5XX',
  SCHEMA: 'SCHEMA',
  ENROLLMENT: 'ENROLLMENT',
  VERIFICATION: 'VERIFICATION',
  STORAGE: 'STORAGE',
  ABORTED: 'ABORTED',
  UNKNOWN: 'UNKNOWN',
});

const VALID_STATES = new Set(Object.values(RUNNER_STATE));
const VALID_MUTATION_KINDS = new Set(Object.values(RUNNER_MUTATION_KIND));
const VALID_MUTATION_STATUSES = new Set(Object.values(RUNNER_MUTATION_STATUS));
const VALID_ERROR_CATEGORIES = new Set(Object.values(RUNNER_ERROR_CATEGORY));
const UNVERIFIED_MUTATION_STATUSES = new Set([
  RUNNER_MUTATION_STATUS.PREPARED,
  RUNNER_MUTATION_STATUS.IN_FLIGHT,
  RUNNER_MUTATION_STATUS.ACCEPTED,
  RUNNER_MUTATION_STATUS.UNCERTAIN,
]);
const TERMINAL_STATES = new Set([
  RUNNER_STATE.STOPPED,
  RUNNER_STATE.COMPLETED,
  RUNNER_STATE.FAILED,
]);
const ACTIVE_STATES = [...VALID_STATES].filter((state) => !TERMINAL_STATES.has(state));
const ACTIVE_STATE_PLACEHOLDERS = ACTIVE_STATES.map(() => '?').join(', ');
const NETWORK_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const CHECKPOINT_VERSION = 2;

export class RunnerMutationPendingVerificationError extends Error {
  constructor(jobKey, current) {
    super(`Runner ${jobKey} has an unverified ${current?.mutation_kind ?? 'unknown'} mutation`);
    this.name = 'RunnerMutationPendingVerificationError';
    this.code = 'RUNNER_MUTATION_REQUIRES_VERIFICATION';
    this.jobKey = jobKey;
    this.mutationKind = current?.mutation_kind ?? null;
    this.mutationStatus = current?.mutation_status ?? null;
  }
}

const ADDITIVE_COLUMNS = Object.freeze({
  checkpoint_version: `INTEGER NOT NULL DEFAULT ${CHECKPOINT_VERSION}`,
  quest_event: 'TEXT',
  server_progress_seconds: 'REAL',
  mutation_kind: 'TEXT',
  mutation_status: `TEXT NOT NULL DEFAULT '${RUNNER_MUTATION_STATUS.NONE}'`,
  mutation_payload_json: 'TEXT',
  mutation_attempted_at: 'TEXT',
  mutation_verified_at: 'TEXT',
  error_category: 'TEXT',
  state_source: `TEXT NOT NULL DEFAULT 'legacy-observer'`,
});

function assertState(state) {
  if (!VALID_STATES.has(state)) throw new Error(`Unknown durable runner state: ${state}`);
}

function assertOptionalEnum(value, valid, label) {
  if (value != null && !valid.has(value)) throw new Error(`Unknown ${label}: ${value}`);
}

function json(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseRunnerState(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata_json, row.metadata_json ? { invalidMetadata: true } : null),
    mutation_payload: parseJson(
      row.mutation_payload_json,
      row.mutation_payload_json ? { invalidMutationPayload: true } : null,
    ),
  };
}

function optionOrCurrent(options, optionName, current, columnName, fallback = null) {
  if (Object.hasOwn(options, optionName)) return options[optionName];
  return current?.[columnName] ?? fallback;
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

export function ensureRunnerStateSchema(database = db) {
  const migrate = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS runner_states (
        job_key                 TEXT PRIMARY KEY,
        owner_id                TEXT NOT NULL,
        account_id              TEXT,
        username                TEXT,
        mode                    TEXT NOT NULL,
        schedule_id             INTEGER,
        state                   TEXT NOT NULL,
        quest_id                TEXT,
        quest_name              TEXT,
        progress                REAL,
        next_action_at          TEXT,
        retry_count             INTEGER NOT NULL DEFAULT 0,
        last_error              TEXT,
        metadata_json           TEXT,
        checkpoint_version      INTEGER NOT NULL DEFAULT ${CHECKPOINT_VERSION},
        quest_event             TEXT,
        server_progress_seconds REAL,
        mutation_kind           TEXT,
        mutation_status         TEXT NOT NULL DEFAULT '${RUNNER_MUTATION_STATUS.NONE}',
        mutation_payload_json   TEXT,
        mutation_attempted_at   TEXT,
        mutation_verified_at    TEXT,
        error_category          TEXT,
        state_source            TEXT NOT NULL DEFAULT 'legacy-observer',
        started_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at            TEXT
      );
    `);

    const columns = tableColumns(database, 'runner_states');
    for (const [name, declaration] of Object.entries(ADDITIVE_COLUMNS)) {
      if (!columns.has(name)) database.exec(`ALTER TABLE runner_states ADD COLUMN ${name} ${declaration}`);
    }

    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_runner_states_owner
        ON runner_states(owner_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runner_states_state
        ON runner_states(state, next_action_at);
      CREATE INDEX IF NOT EXISTS idx_runner_states_mutation
        ON runner_states(mutation_status, mutation_kind, updated_at);
    `);
    return tableColumns(database, 'runner_states');
  });
  return migrate.immediate();
}

ensureRunnerStateSchema();

const upsertRunnerState = db.prepare(`
  INSERT INTO runner_states (
    job_key, owner_id, account_id, username, mode, schedule_id, state,
    quest_id, quest_name, progress, next_action_at, retry_count,
    last_error, metadata_json, checkpoint_version, quest_event,
    server_progress_seconds, mutation_kind, mutation_status,
    mutation_payload_json, mutation_attempted_at, mutation_verified_at,
    error_category, state_source, completed_at
  ) VALUES (
    @jobKey, @ownerId, @accountId, @username, @mode, @scheduleId, @state,
    @questId, @questName, @progress, @nextActionAt, @retryCount,
    @lastError, @metadataJson, @checkpointVersion, @questEvent,
    @serverProgressSeconds, @mutationKind, @mutationStatus,
    @mutationPayloadJson, @mutationAttemptedAt, @mutationVerifiedAt,
    @errorCategory, @stateSource, @completedAt
  )
  ON CONFLICT(job_key) DO UPDATE SET
    owner_id = excluded.owner_id,
    account_id = COALESCE(excluded.account_id, runner_states.account_id),
    username = COALESCE(excluded.username, runner_states.username),
    mode = excluded.mode,
    schedule_id = COALESCE(excluded.schedule_id, runner_states.schedule_id),
    state = excluded.state,
    quest_id = excluded.quest_id,
    quest_name = excluded.quest_name,
    progress = excluded.progress,
    next_action_at = excluded.next_action_at,
    retry_count = excluded.retry_count,
    last_error = excluded.last_error,
    metadata_json = excluded.metadata_json,
    checkpoint_version = excluded.checkpoint_version,
    quest_event = excluded.quest_event,
    server_progress_seconds = excluded.server_progress_seconds,
    mutation_kind = excluded.mutation_kind,
    mutation_status = excluded.mutation_status,
    mutation_payload_json = excluded.mutation_payload_json,
    mutation_attempted_at = excluded.mutation_attempted_at,
    mutation_verified_at = excluded.mutation_verified_at,
    error_category = excluded.error_category,
    state_source = excluded.state_source,
    completed_at = excluded.completed_at,
    updated_at = datetime('now')
`);

function mutationRunState(kind) {
  return {
    [RUNNER_MUTATION_KIND.ENROLL]: RUNNER_STATE.ENROLLING,
    [RUNNER_MUTATION_KIND.VIDEO_PROGRESS]: RUNNER_STATE.RUNNING_PROGRESS,
    [RUNNER_MUTATION_KIND.HEARTBEAT]: RUNNER_STATE.RUNNING_PROGRESS,
    [RUNNER_MUTATION_KIND.CLAIM]: RUNNER_STATE.CLAIMING,
  }[kind] ?? RUNNER_STATE.RUNNING;
}

export function mutationVerificationState(kind) {
  return {
    [RUNNER_MUTATION_KIND.ENROLL]: RUNNER_STATE.VERIFYING_ENROLLMENT,
    [RUNNER_MUTATION_KIND.VIDEO_PROGRESS]: RUNNER_STATE.VERIFYING_PROGRESS,
    [RUNNER_MUTATION_KIND.HEARTBEAT]: RUNNER_STATE.VERIFYING_PROGRESS,
    [RUNNER_MUTATION_KIND.CLAIM]: RUNNER_STATE.VERIFYING_CLAIM,
  }[kind] ?? RUNNER_STATE.VERIFYING_COMPLETION;
}

function classifyNamedRunnerError(error) {
  if (error?.name === 'AbortError' || error?.message === 'aborted') {
    return RUNNER_ERROR_CATEGORY.ABORTED;
  }
  if (error?.name === 'QuestCompatibilityError') return RUNNER_ERROR_CATEGORY.SCHEMA;
  if (error?.name === 'RequestTimeoutError' || error?.code === 'ETIMEDOUT') {
    return RUNNER_ERROR_CATEGORY.TIMEOUT;
  }
  return null;
}

function classifyHttpRunnerError(error) {
  const status = error?.status;
  if (status === 401 || status === 403) return RUNNER_ERROR_CATEGORY.AUTH;
  if (status === 429) return RUNNER_ERROR_CATEGORY.RATE_LIMIT;
  if (Number.isInteger(status) && status >= 500) return RUNNER_ERROR_CATEGORY.API_5XX;
  if (Number.isInteger(status) && status >= 400) return RUNNER_ERROR_CATEGORY.API_4XX;
  return null;
}

function classifyCodeRunnerError(error) {
  for (const rawCode of [error?.code, error?.cause?.code]) {
    const code = String(rawCode ?? '');
    if (code.startsWith('SQLITE_')) return RUNNER_ERROR_CATEGORY.STORAGE;
    if (NETWORK_ERROR_CODES.has(code) || code.startsWith('UND_ERR_')) {
      return RUNNER_ERROR_CATEGORY.NETWORK;
    }
  }
  return null;
}

export function classifyRunnerError(error) {
  const category = classifyNamedRunnerError(error)
    ?? classifyHttpRunnerError(error)
    ?? classifyCodeRunnerError(error);
  if (category) return category;
  if (error?.message === 'fetch failed') return RUNNER_ERROR_CATEGORY.NETWORK;
  return RUNNER_ERROR_CATEGORY.UNKNOWN;
}

export function sanitizeRunnerMutationPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const allowed = [
    'timestamp',
    'terminal',
    'platform',
    'application_id',
    'location',
    'is_targeted',
    'metadata_raw',
  ];
  const result = {};
  for (const key of allowed) {
    const value = payload[key];
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
  }
  return Object.keys(result).length ? result : null;
}

export function beginRunnerState({
  jobKey,
  ownerId,
  accountId = null,
  username = null,
  mode,
  scheduleId = null,
  state = RUNNER_STATE.QUEUED,
  nextActionAt = null,
  metadata = null,
  stateSource = 'runner-service',
}) {
  assertState(state);
  upsertRunnerState.run({
    jobKey,
    ownerId,
    accountId,
    username,
    mode,
    scheduleId,
    state,
    questId: null,
    questName: null,
    progress: null,
    nextActionAt,
    retryCount: 0,
    lastError: null,
    metadataJson: json(metadata),
    checkpointVersion: CHECKPOINT_VERSION,
    questEvent: null,
    serverProgressSeconds: null,
    mutationKind: null,
    mutationStatus: RUNNER_MUTATION_STATUS.NONE,
    mutationPayloadJson: null,
    mutationAttemptedAt: null,
    mutationVerifiedAt: null,
    errorCategory: null,
    stateSource,
    completedAt: TERMINAL_STATES.has(state) ? new Date().toISOString() : null,
  });
  return getRunnerState(jobKey);
}

export function transitionRunnerState(jobKey, state, options = {}) {
  assertState(state);
  const current = getRunnerState(jobKey);
  const ownerId = optionOrCurrent(options, 'ownerId', current, 'owner_id');
  const mode = optionOrCurrent(options, 'mode', current, 'mode');
  if (!current && (!ownerId || !mode)) {
    throw new Error(`Runner state ${jobKey} does not exist and cannot be created implicitly`);
  }

  const mutationKind = optionOrCurrent(options, 'mutationKind', current, 'mutation_kind');
  const mutationStatus = optionOrCurrent(
    options,
    'mutationStatus',
    current,
    'mutation_status',
    RUNNER_MUTATION_STATUS.NONE,
  );
  const errorCategory = optionOrCurrent(options, 'errorCategory', current, 'error_category');
  assertOptionalEnum(mutationKind, VALID_MUTATION_KINDS, 'runner mutation kind');
  assertOptionalEnum(mutationStatus, VALID_MUTATION_STATUSES, 'runner mutation status');
  assertOptionalEnum(errorCategory, VALID_ERROR_CATEGORIES, 'runner error category');

  const mutationPayload = optionOrCurrent(
    options,
    'mutationPayload',
    current,
    'mutation_payload',
  );
  upsertRunnerState.run({
    jobKey,
    ownerId,
    accountId: optionOrCurrent(options, 'accountId', current, 'account_id'),
    username: optionOrCurrent(options, 'username', current, 'username'),
    mode,
    scheduleId: optionOrCurrent(options, 'scheduleId', current, 'schedule_id'),
    state,
    questId: optionOrCurrent(options, 'questId', current, 'quest_id'),
    questName: optionOrCurrent(options, 'questName', current, 'quest_name'),
    progress: optionOrCurrent(options, 'progress', current, 'progress'),
    nextActionAt: optionOrCurrent(options, 'nextActionAt', current, 'next_action_at'),
    retryCount: optionOrCurrent(options, 'retryCount', current, 'retry_count', 0),
    lastError: optionOrCurrent(options, 'lastError', current, 'last_error'),
    metadataJson: json(optionOrCurrent(options, 'metadata', current, 'metadata')),
    checkpointVersion: optionOrCurrent(
      options,
      'checkpointVersion',
      current,
      'checkpoint_version',
      CHECKPOINT_VERSION,
    ),
    questEvent: optionOrCurrent(options, 'questEvent', current, 'quest_event'),
    serverProgressSeconds: optionOrCurrent(
      options,
      'serverProgressSeconds',
      current,
      'server_progress_seconds',
    ),
    mutationKind,
    mutationStatus,
    mutationPayloadJson: json(mutationPayload),
    mutationAttemptedAt: optionOrCurrent(
      options,
      'mutationAttemptedAt',
      current,
      'mutation_attempted_at',
    ),
    mutationVerifiedAt: optionOrCurrent(
      options,
      'mutationVerifiedAt',
      current,
      'mutation_verified_at',
    ),
    errorCategory,
    stateSource: optionOrCurrent(options, 'stateSource', current, 'state_source', 'legacy-observer'),
    completedAt: TERMINAL_STATES.has(state) ? new Date().toISOString() : null,
  });
  return getRunnerState(jobKey);
}

export function prepareRunnerMutation(jobKey, {
  kind,
  questId,
  questName,
  questEvent,
  payload = null,
  stateSource = 'rate-limit-coordinator',
} = {}) {
  if (!VALID_MUTATION_KINDS.has(kind)) throw new Error(`Unknown runner mutation kind: ${kind}`);
  const current = getRunnerState(jobKey);
  if (!current || TERMINAL_STATES.has(current.state)) return current;
  if (UNVERIFIED_MUTATION_STATUSES.has(current.mutation_status)) {
    throw new RunnerMutationPendingVerificationError(jobKey, current);
  }
  return transitionRunnerState(jobKey, mutationRunState(kind), {
    questId: questId ?? current.quest_id,
    questName: questName ?? current.quest_name,
    questEvent: questEvent ?? current.quest_event,
    mutationKind: kind,
    mutationStatus: RUNNER_MUTATION_STATUS.PREPARED,
    mutationPayload: sanitizeRunnerMutationPayload(payload),
    mutationAttemptedAt: null,
    mutationVerifiedAt: null,
    errorCategory: null,
    lastError: null,
    stateSource,
  });
}

export function markRunnerMutationInFlight(jobKey, now = new Date()) {
  const current = getRunnerState(jobKey);
  if (!current?.mutation_kind || TERMINAL_STATES.has(current.state)) return current;
  return transitionRunnerState(jobKey, mutationRunState(current.mutation_kind), {
    mutationStatus: RUNNER_MUTATION_STATUS.IN_FLIGHT,
    mutationAttemptedAt: now.toISOString(),
    mutationVerifiedAt: null,
    errorCategory: null,
    lastError: null,
    stateSource: 'rate-limit-coordinator',
  });
}

export function markRunnerMutationAccepted(jobKey, now = new Date()) {
  const current = getRunnerState(jobKey);
  if (!current?.mutation_kind || TERMINAL_STATES.has(current.state)) return current;
  return transitionRunnerState(jobKey, mutationVerificationState(current.mutation_kind), {
    mutationStatus: RUNNER_MUTATION_STATUS.ACCEPTED,
    nextActionAt: now.toISOString(),
    errorCategory: null,
    lastError: null,
    stateSource: 'mutation-response',
  });
}

export function markRunnerMutationUncertain(jobKey, error, now = new Date()) {
  const current = getRunnerState(jobKey);
  if (!current?.mutation_kind || TERMINAL_STATES.has(current.state)) return current;
  return transitionRunnerState(jobKey, mutationVerificationState(current.mutation_kind), {
    mutationStatus: RUNNER_MUTATION_STATUS.UNCERTAIN,
    nextActionAt: now.toISOString(),
    lastError: error?.message ?? String(error),
    errorCategory: classifyRunnerError(error),
    stateSource: 'mutation-verification',
  });
}

export function markRunnerMutationVerified(jobKey, {
  progress = undefined,
  serverProgressSeconds = undefined,
  now = new Date(),
  state = RUNNER_STATE.RUNNING,
} = {}) {
  const current = getRunnerState(jobKey);
  if (!current?.mutation_kind || TERMINAL_STATES.has(current.state)) return current;
  return transitionRunnerState(jobKey, state, {
    ...(progress !== undefined ? { progress } : {}),
    ...(serverProgressSeconds !== undefined ? { serverProgressSeconds } : {}),
    mutationStatus: RUNNER_MUTATION_STATUS.VERIFIED,
    mutationVerifiedAt: now.toISOString(),
    nextActionAt: null,
    lastError: null,
    errorCategory: null,
    stateSource: 'fresh-server-verification',
  });
}

export function markRunnerMutationFailed(jobKey, error, {
  state = RUNNER_STATE.WAITING_RETRY,
  nextActionAt = null,
} = {}) {
  const current = getRunnerState(jobKey);
  if (!current || TERMINAL_STATES.has(current.state)) return current;
  return transitionRunnerState(jobKey, state, {
    mutationStatus: RUNNER_MUTATION_STATUS.FAILED,
    nextActionAt,
    lastError: error?.message ?? String(error),
    errorCategory: classifyRunnerError(error),
    stateSource: 'mutation-failure',
  });
}

export function incrementRunnerRetry(jobKey) {
  const current = getRunnerState(jobKey);
  if (!current || TERMINAL_STATES.has(current.state)) return current;
  return transitionRunnerState(jobKey, current.state, {
    retryCount: Number(current.retry_count ?? 0) + 1,
    stateSource: 'controlled-mutation-retry',
  });
}

export function clearRunnerMutationCheckpoint(jobKey, state = RUNNER_STATE.RUNNING) {
  const current = getRunnerState(jobKey);
  if (!current || TERMINAL_STATES.has(current.state)) return current;
  return transitionRunnerState(jobKey, state, {
    mutationKind: null,
    mutationStatus: RUNNER_MUTATION_STATUS.NONE,
    mutationPayload: null,
    mutationAttemptedAt: null,
    mutationVerifiedAt: null,
    errorCategory: null,
    lastError: null,
    stateSource: 'checkpoint-cleared',
  });
}

export function getRunnerState(jobKey) {
  return parseRunnerState(db.prepare(
    'SELECT * FROM runner_states WHERE job_key = ?',
  ).get(jobKey));
}

export function listStoppingScheduledRunnerStates() {
  return db.prepare(`
    SELECT * FROM runner_states
    WHERE mode = 'scheduled' AND state = ?
    ORDER BY updated_at ASC, job_key ASC
  `).all(RUNNER_STATE.STOPPING).map(parseRunnerState);
}

export function listRunnerStates({ ownerId = null, activeOnly = false, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (ownerId) {
    clauses.push('owner_id = ?');
    params.push(ownerId);
  }
  if (activeOnly) {
    clauses.push(`state IN (${ACTIVE_STATE_PLACEHOLDERS})`);
    params.push(...ACTIVE_STATES);
  }
  params.push(Math.max(1, Math.min(500, limit)));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT * FROM runner_states
    ${where}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...params).map(parseRunnerState);
}

export function markInterruptedRunnerStates(now = new Date(), {
  includeOneShot = true,
  includeScheduled = true,
} = {}) {
  const nextActionAt = now.toISOString();
  const completedAt = now.toISOString();
  const markScheduled = db.prepare(`
    UPDATE runner_states
    SET state = ?,
        next_action_at = ?,
        completed_at = NULL,
        last_error = 'Process restarted before the previous lifecycle completed',
        error_category = ?,
        state_source = 'restart-reconciliation',
        updated_at = datetime('now')
    WHERE mode = 'scheduled'
      AND state IN (${ACTIVE_STATE_PLACEHOLDERS})
  `);
  const failOneShot = db.prepare(`
    UPDATE runner_states
    SET state = ?,
        next_action_at = NULL,
        completed_at = ?,
        last_error = 'Process restarted; one-shot runners cannot be restored',
        error_category = ?,
        state_source = 'restart-reconciliation',
        updated_at = datetime('now')
    WHERE mode != 'scheduled'
      AND state IN (${ACTIVE_STATE_PLACEHOLDERS})
  `);
  const reconcile = db.transaction(() => {
    let changed = 0;
    if (includeScheduled) {
      changed += markScheduled.run(
        RUNNER_STATE.RECOVERING,
        nextActionAt,
        RUNNER_ERROR_CATEGORY.ABORTED,
        ...ACTIVE_STATES,
      ).changes;
    }
    if (includeOneShot) {
      changed += failOneShot.run(
        RUNNER_STATE.FAILED,
        completedAt,
        RUNNER_ERROR_CATEGORY.ABORTED,
        ...ACTIVE_STATES,
      ).changes;
    }
    return changed;
  });
  return reconcile();
}

export function pruneRunnerStates({ retentionDays = 30, keepLatest = 500 } = {}) {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  db.prepare(`
    DELETE FROM runner_states
    WHERE state IN (?, ?, ?)
      AND completed_at IS NOT NULL
      AND completed_at < ?
  `).run(RUNNER_STATE.STOPPED, RUNNER_STATE.COMPLETED, RUNNER_STATE.FAILED, cutoff);

  const stale = db.prepare(`
    SELECT job_key FROM runner_states
    WHERE state IN (?, ?, ?)
    ORDER BY updated_at DESC
    LIMIT -1 OFFSET ?
  `).all(RUNNER_STATE.STOPPED, RUNNER_STATE.COMPLETED, RUNNER_STATE.FAILED, keepLatest);
  const remove = db.prepare('DELETE FROM runner_states WHERE job_key = ?');
  const transaction = db.transaction((rows) => rows.forEach((row) => remove.run(row.job_key)));
  transaction(stale);
  return stale.length;
}

export function clearRunnerStatesForTests() {
  db.prepare('DELETE FROM runner_states').run();
}
