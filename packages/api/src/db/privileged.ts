import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { getPrivilegedPoolInternal } from './client.js';

// ============================================================================
// Privileged (owner / BYPASSRLS) database access — item 6c
// ----------------------------------------------------------------------------
// This pool bypasses Row-Level Security. It is ONLY for work that is genuinely
// cross-tenant or happens before a tenant is known. Every caller must be on the
// allowlist below, which the RLS guard test asserts against. Tenant request
// paths must use getTenantDb()/runWithTenant() instead — never this.
//
// Allowlisted privileged callers:
//   - auth-service        credential lookup + login (tenant not yet known)
//   - api-key-service     verifying a key resolves its tenant (pre-context)
//   - oauth-service       verifying a client resolves its tenant (pre-context)
//   - routes/metrics      deliberately cross-tenant aggregate counts (no PHI rows)
//   - jobs/*              background workers that bind the tenant per job
// ============================================================================

/**
 * The owner/BYPASSRLS pool. Reserved for the allowlisted cross-tenant and
 * pre-tenant paths documented above. Do NOT use for tenant request handling.
 */
export function getPrivilegedPool(config: Pick<Config, 'DATABASE_URL' | 'APP_DATABASE_URL' | 'DB_POOL_MIN' | 'DB_POOL_MAX'>): Pool {
  return getPrivilegedPoolInternal(config);
}
