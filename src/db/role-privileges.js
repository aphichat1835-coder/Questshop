const APPEND_ONLY_TABLES = new Set(['wallet_transactions', 'admin_audit_logs', 'release_evidence']);
const READ_ONLY_TABLES = new Set(['schema_migrations', 'crypto_key_sentinels']);

export const ALLOWED_RUNTIME_FUNCTIONS = Object.freeze([
  'public.questshop_prune_wallet_ledger(timestamp with time zone,integer)',
  'public.questshop_prune_operational_details(timestamp with time zone,timestamp with time zone,integer)',
]);

const allowedFunctionOidSql = `p.oid = ANY (ARRAY[
  to_regprocedure('public.questshop_prune_wallet_ledger(timestamp with time zone,integer)'),
  to_regprocedure('public.questshop_prune_operational_details(timestamp with time zone,timestamp with time zone,integer)')
])`;

export function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function assertRuntimeRole(runtimeRole, migratorRole = null) {
  if (typeof runtimeRole !== 'string' || runtimeRole.trim() === '') {
    throw Object.assign(new Error('DATABASE_POOL_URL must name a non-empty runtime role for privilege synchronization'), {
      code: 'RUNTIME_ROLE_REQUIRED',
    });
  }
  if (migratorRole && runtimeRole === migratorRole) {
    throw Object.assign(new Error('Runtime role must differ from PostgreSQL current_user used for migrations'), {
      code: 'RUNTIME_MIGRATOR_ROLE_CONFLICT',
    });
  }
  return runtimeRole;
}

async function applicationTables(client, owner) {
  return (await client.query(`SELECT c.oid, c.relname,
    format('%I.%I', n.nspname, c.relname) AS qualified_name,
    pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
      AND ($1::text IS NULL OR pg_get_userbyid(c.relowner)=$1)
    ORDER BY c.relname`, [owner])).rows;
}

async function applicationSequences(client, owner) {
  return (await client.query(`SELECT c.oid, c.relname,
    format('%I.%I', n.nspname, c.relname) AS qualified_name,
    pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='S'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
        WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
      AND ($1::text IS NULL OR pg_get_userbyid(c.relowner)=$1)
    ORDER BY c.relname`, [owner])).rows;
}

async function questshopFunctions(client, owner) {
  return (await client.query(`SELECT p.oid, p.proname,
    format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS qualified_signature,
    format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))::text AS identity,
    ${allowedFunctionOidSql} AS is_allowed,
    pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'questshop\\_%' ESCAPE '\\'
      AND ($1::text IS NULL OR pg_get_userbyid(p.proowner)=$1)
    ORDER BY p.proname, p.oid`, [owner])).rows;
}

function tablePrivileges(name) {
  if (APPEND_ONLY_TABLES.has(name)) return ['SELECT', 'INSERT'];
  if (READ_ONLY_TABLES.has(name)) return ['SELECT'];
  return ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
}

function assertProtectedObjects(rows, names, type) {
  const found = new Set(rows.map((row) => row.relname));
  for (const name of names) {
    if (!found.has(name)) {
      throw Object.assign(new Error(`Migrator does not own required ${type} ${name}`), {
        code: 'PRIVILEGE_OBJECT_OWNER_MISMATCH',
      });
    }
  }
}

async function synchronizeTables(client, runtimeRole, migratorRole) {
  const tables = await applicationTables(client, migratorRole);
  assertProtectedObjects(tables, [...APPEND_ONLY_TABLES, ...READ_ONLY_TABLES], 'table');
  const runtime = quoteIdentifier(runtimeRole);
  for (const table of tables) {
    await client.query(`REVOKE ALL PRIVILEGES ON TABLE ${table.qualified_name} FROM ${runtime}`);
    await client.query(`GRANT ${tablePrivileges(table.relname).join(', ')} ON TABLE ${table.qualified_name} TO ${runtime}`);
  }
  return tables;
}

async function synchronizeSequences(client, runtimeRole, migratorRole) {
  const sequences = await applicationSequences(client, migratorRole);
  const runtime = quoteIdentifier(runtimeRole);
  for (const sequence of sequences) {
    await client.query(`REVOKE ALL PRIVILEGES ON SEQUENCE ${sequence.qualified_name} FROM ${runtime}`);
    await client.query(`GRANT USAGE, SELECT ON SEQUENCE ${sequence.qualified_name} TO ${runtime}`);
  }
  return sequences;
}

async function synchronizeFunctions(client, runtimeRole, migratorRole) {
  const functions = await questshopFunctions(client, migratorRole);
  const runtime = quoteIdentifier(runtimeRole);
  for (const allowed of ALLOWED_RUNTIME_FUNCTIONS) {
    const expected = (await client.query('SELECT to_regprocedure($1)::oid AS oid', [allowed])).rows[0].oid;
    if (!expected || !functions.some((item) => String(item.oid) === String(expected))) {
      throw Object.assign(new Error(`Required Questshop retention function is missing or has a different owner/signature: ${allowed}`), {
        code: 'PRIVILEGE_FUNCTION_CONTRACT_MISMATCH',
      });
    }
  }
  for (const fn of functions) {
    // qualified_signature comes from PostgreSQL format/pg_get_function_identity_arguments,
    // never from a raw function name supplied by configuration.
    await client.query(`REVOKE EXECUTE ON FUNCTION ${fn.qualified_signature} FROM PUBLIC`);
    await client.query(`REVOKE EXECUTE ON FUNCTION ${fn.qualified_signature} FROM ${runtime}`);
  }
  for (const fn of functions.filter((item) => item.is_allowed)) {
    await client.query(`GRANT EXECUTE ON FUNCTION ${fn.qualified_signature} TO ${runtime}`);
  }
  return functions;
}

export async function synchronizeRuntimeObjectPrivileges(client, { runtimeRole }) {
  const migratorRole = (await client.query('SELECT current_user AS role')).rows[0].role;
  assertRuntimeRole(runtimeRole, migratorRole);
  const runtime = quoteIdentifier(runtimeRole);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${runtime}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${runtime}`);
  // PostgreSQL combines global and per-schema default ACLs. Revoking only the
  // schema layer would leave the global default PUBLIC EXECUTE in effect.
  await client.query('ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
  await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
  const tables = await synchronizeTables(client, runtimeRole, migratorRole);
  const sequences = await synchronizeSequences(client, runtimeRole, migratorRole);
  const functions = await synchronizeFunctions(client, runtimeRole, migratorRole);
  return { migratorRole, tables: tables.length, sequences: sequences.length, functions: functions.length };
}

export async function inspectRuntimeObjectPrivileges(client, { runtimeRole }) {
  assertRuntimeRole(runtimeRole);
  // This function also runs inside the single-client migration transaction.
  // node-postgres requires those queries to be sequenced, not Promise.all.
  const schema = await client.query(`SELECT has_schema_privilege($1,'public','USAGE') AS can_use_schema,
      has_schema_privilege($1,'public','CREATE') AS can_create_schema_objects`, [runtimeRole]);
  const tables = await client.query(`SELECT c.oid, c.relname, pg_get_userbyid(c.relowner) AS owner,
      has_table_privilege($1,c.oid,'SELECT') AS can_select,
      has_table_privilege($1,c.oid,'INSERT') AS can_insert,
      has_table_privilege($1,c.oid,'UPDATE') AS can_update,
      has_table_privilege($1,c.oid,'DELETE') AS can_delete,
      has_table_privilege($1,c.oid,'TRUNCATE') AS can_truncate,
      has_table_privilege($1,c.oid,'REFERENCES') AS can_reference,
      has_table_privilege($1,c.oid,'TRIGGER') AS can_trigger
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
          AND d.objid=c.oid AND d.deptype='e') ORDER BY c.relname`, [runtimeRole]);
  const sequences = await client.query(`SELECT c.oid, c.relname, pg_get_userbyid(c.relowner) AS owner,
      has_sequence_privilege($1,c.oid,'USAGE') AS can_use,
      has_sequence_privilege($1,c.oid,'SELECT') AS can_select,
      has_sequence_privilege($1,c.oid,'UPDATE') AS can_update
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='S'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
          AND d.objid=c.oid AND d.deptype='e') ORDER BY c.relname`, [runtimeRole]);
  const functions = await client.query(`SELECT p.oid, p.proname,
      format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))::text AS identity,
      pg_get_userbyid(p.proowner) AS owner,
      ${allowedFunctionOidSql} AS is_allowed,
      has_function_privilege($1,p.oid,'EXECUTE') AS can_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'questshop\\_%' ESCAPE '\\'
      ORDER BY p.proname,p.oid`, [runtimeRole]);
  const ownership = await client.query(`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','S')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
            AND d.objid=c.oid AND d.deptype='e')
          AND pg_get_userbyid(c.relowner)=$1) AS owns_relation,
      EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE 'questshop\\_%' ESCAPE '\\'
          AND pg_get_userbyid(p.proowner)=$1) AS owns_function`, [runtimeRole]);
  return { runtimeRole, schema: schema.rows[0], tables: tables.rows, sequences: sequences.rows,
    functions: functions.rows, ownership: ownership.rows[0] };
}

export function runtimePrivilegeViolations(snapshot) {
  const violations = [];
  if (!snapshot.schema.can_use_schema) violations.push('runtime role cannot use public schema');
  if (snapshot.schema.can_create_schema_objects) violations.push('runtime role can CREATE in public schema');
  if (snapshot.ownership.owns_relation || snapshot.ownership.owns_function) {
    violations.push('runtime role owns Questshop application objects');
  }
  for (const table of snapshot.tables) {
    const expected = new Set(tablePrivileges(table.relname));
    const checks = { SELECT: table.can_select, INSERT: table.can_insert, UPDATE: table.can_update, DELETE: table.can_delete };
    for (const [privilege, granted] of Object.entries(checks)) {
      if (expected.has(privilege) !== granted) violations.push(`table ${table.relname} ${privilege} effective privilege violates policy`);
    }
    if (table.can_truncate || table.can_reference || table.can_trigger) {
      violations.push(`table ${table.relname} has forbidden effective structural privilege`);
    }
  }
  for (const sequence of snapshot.sequences) {
    if (!sequence.can_use || !sequence.can_select || sequence.can_update) {
      violations.push(`sequence ${sequence.relname} effective privilege violates policy`);
    }
  }
  for (const fn of snapshot.functions) {
    if (fn.is_allowed !== fn.can_execute) {
      violations.push(`function ${fn.identity} effective EXECUTE privilege violates policy`);
    }
  }
  if (snapshot.functions.filter((fn) => fn.is_allowed).length !== ALLOWED_RUNTIME_FUNCTIONS.length) {
    violations.push('one or more required Questshop retention functions are missing');
  }
  return violations;
}
