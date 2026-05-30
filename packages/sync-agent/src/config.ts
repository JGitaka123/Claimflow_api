import { config as loadDotEnv } from 'dotenv';
import { z } from 'zod';

loadDotEnv();

const nullableString = z
  .string()
  .optional()
  .transform((value: string | undefined) => {
    if (value === undefined) {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  });

export const syncAgentConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MIN: z.coerce.number().int().min(0).default(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),

  CONTROL_PLANE_URL: nullableString,
  CONTROL_PLANE_PUBLIC_KEY: nullableString,
  LICENSE_TOKEN: nullableString,

  RULEPACK_DIR: z.string().default('/data/rulepacks'),
  STORAGE_PATH: z.string().default('/data'),
  KEY_PATH: z.string().default('/etc/claimflow/keys'),

  SYNC_GOVERNANCE_MODE: z.enum(['METRICS_ONLY', 'DEIDENTIFIED', 'FULL_ANALYTICS']).default('METRICS_ONLY'),
  SYNC_INTERVAL_HOURS: z.coerce.number().int().min(1).max(24).default(6),
  HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  SOFTWARE_VERSION: z.string().default('1.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type SyncAgentConfig = z.infer<typeof syncAgentConfigSchema>;

interface LoadSyncAgentConfigOptions {
  env?: NodeJS.ProcessEnv;
  exitOnError?: boolean;
}

export function loadSyncAgentConfig(options: LoadSyncAgentConfigOptions = {}): SyncAgentConfig {
  const { env = process.env, exitOnError = true } = options;

  const parsed = syncAgentConfigSchema.safeParse(env);
  if (parsed.success) {
    return parsed.data;
  }

  for (const issue of parsed.error.issues) {
    const key = issue.path.join('.') || 'unknown';
    // eslint-disable-next-line no-console
    console.error(`[sync-agent config] ${key}: ${issue.message}`);
  }

  if (exitOnError) {
    process.exit(1);
  }

  throw new Error('Invalid sync-agent configuration');
}
