import '../src/config/load-local-environment.js';
import { loadEnvironment } from '../src/config/env.js';

// This command deliberately validates only local configuration. It never
// generates/replaces a secret, connects to Discord/TrueMoney, or prints a
// credential. Startup performs the database key-sentinel verification.
const env = loadEnvironment();
console.log(JSON.stringify({ ok: true, nodeEnv: env.NODE_ENV, guildIdConfigured: Boolean(env.DISCORD_GUILD_ID),
  backupEnabled: env.BACKUP_ENABLED ?? env.NODE_ENV === 'production', keyringVersions: {
    data: env.DATA_ENCRYPTION_KEYS_JSON.current, voucher: env.VOUCHER_HMAC_KEYS_JSON.current,
    backup: env.BACKUP_ENCRYPTION_KEYS_JSON?.current ?? null,
  } }));
