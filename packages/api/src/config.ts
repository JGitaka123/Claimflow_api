import { config as loadDotEnv } from 'dotenv';
import { z } from 'zod';
import { isMlServiceExposedHost } from './integrations/ml-network.js';

loadDotEnv();

const nullableString = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  });

const baseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // The non-superuser, non-BYPASSRLS application role used for all tenant-scoped
  // access (item 6c). Falls back to DATABASE_URL when unset (dev/test before the
  // role is provisioned); loadConfig warns when this fallback is used in production.
  APP_DATABASE_URL: nullableString,
  DB_POOL_MIN: z.coerce.number().int().min(0).default(5),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(20),

  STORAGE_PATH: z.string().default('/data'),

  ML_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  ML_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),

  RULEPACK_DIR: z.string().default('/data/rulepacks'),

  KEY_PATH: z.string().default('/etc/claimflow/keys'),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),
  REQUIRE_MFA: z.coerce.boolean().default(true),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(12),
  MAX_LOGIN_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  LOCKOUT_DURATION_MINUTES: z.coerce.number().int().min(1).default(15),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(30),

  RATE_LIMIT_RPM: z.coerce.number().int().min(1).default(100),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().min(1).default(50),
  MAX_PAGES_PER_DOCUMENT: z.coerce.number().int().min(1).default(50),
  MAX_CLAIMS_PER_BATCH: z.coerce.number().int().min(1).max(200).default(200),
  BATCH_CONCURRENCY: z.coerce.number().int().min(1).default(4),

  CONF_THRESHOLD_HIGH: z.coerce.number().min(0).max(1).default(0.85),
  CONF_THRESHOLD_LOW: z.coerce.number().min(0).max(1).default(0.6),
  MANUAL_ENTRY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),

  LICENSE_TOKEN: nullableString,

  CONTROL_PLANE_URL: nullableString,
  SYNC_GOVERNANCE_MODE: z.enum(['METRICS_ONLY', 'DEIDENTIFIED', 'FULL_ANALYTICS']).default('METRICS_ONLY'),
  SYNC_INTERVAL_HOURS: z.coerce.number().int().min(1).default(6),

  AFYALINK_ENV: z.enum(['UAT', 'PRODUCTION']).default('UAT'),
  AFYALINK_CLIENT_ID: nullableString,
  AFYALINK_CLIENT_SECRET: nullableString,
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().min(1).default(5),
  CIRCUIT_BREAKER_RESET_MS: z.coerce.number().int().positive().default(300000),
  REGISTRY_CACHE_TTL_HOURS: z.coerce.number().int().min(1).default(24),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export const configSchema = baseConfigSchema.superRefine((config, ctx) => {
  if (config.NODE_ENV === 'production' && isMlServiceExposedHost(config.ML_SERVICE_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ML_SERVICE_URL'],
      message: 'ML_SERVICE_URL must target an internal service host in production (not localhost/loopback).',
    });
  }
});

export type Config = z.infer<typeof configSchema>;

interface LoadConfigOptions {
  exitOnError?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const { exitOnError = true, env = process.env } = options;

  const parsed = configSchema.safeParse(env);

  if (parsed.success) {
    if (parsed.data.NODE_ENV === 'production' && !parsed.data.APP_DATABASE_URL) {
      // eslint-disable-next-line no-console
      console.warn(
        '[config] APP_DATABASE_URL is not set in production: tenant-scoped queries will run on the ' +
          'privileged DATABASE_URL role, so Postgres RLS provides no isolation backstop. Provision the ' +
          'non-superuser claimflow_app role and set APP_DATABASE_URL.',
      );
    }
    return parsed.data;
  }

  for (const issue of parsed.error.issues) {
    const key = issue.path.join('.') || 'unknown';
    // eslint-disable-next-line no-console
    console.error(`[config] ${key}: ${issue.message}`);
  }

  if (exitOnError) {
    process.exit(1);
  }

  throw new Error('Invalid configuration');
}
