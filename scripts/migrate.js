import { loadEnvironment } from '../src/config/env.js';
import { runMigrations } from '../src/db/migrations.js';
import { closePools } from '../src/db/pools.js';

const env = loadEnvironment();
try { console.log(await runMigrations({ gitSha: env.GIT_SHA,
  runtimeRole: decodeURIComponent(new URL(env.DATABASE_POOL_URL).username) })); }
finally { await closePools(); }
