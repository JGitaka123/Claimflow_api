import { Pool } from 'pg';
import type { SyncAgentConfig } from './config.js';
import type { FacilityContext } from './types.js';

interface FacilityRow {
  facility_id: string;
  tenant_id: string;
  facility_name: string;
  sha_facility_code: string;
}

interface ActiveRulepackRow {
  version_semver: string;
}

export function createPool(config: SyncAgentConfig): Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    min: config.DB_POOL_MIN,
    max: config.DB_POOL_MAX,
  });
}

export async function resolveFacilityContext(pool: Pool): Promise<FacilityContext> {
  const result = await pool.query<FacilityRow>(
    `SELECT
        f.id::text AS facility_id,
        f.tenant_id::text AS tenant_id,
        f.name AS facility_name,
        f.sha_facility_code
       FROM facilities f
      WHERE f.is_active = true
      ORDER BY f.created_at ASC
      LIMIT 1`,
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('No active facility found for sync agent');
  }

  return {
    facilityId: row.facility_id,
    tenantId: row.tenant_id,
    facilityName: row.facility_name,
    shaFacilityCode: row.sha_facility_code,
  };
}

export async function resolveActiveRulepackVersion(pool: Pool): Promise<string> {
  const result = await pool.query<ActiveRulepackRow>(
    `SELECT version_semver
       FROM rulepacks
      WHERE is_activated = true
      ORDER BY activated_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
  );

  return result.rows[0]?.version_semver ?? 'v0.0.0';
}

export async function insertSyncEvent(params: {
  pool: Pool;
  direction: 'UP' | 'DOWN';
  payloadType: 'METRICS' | 'RULEPACK' | 'MODEL' | 'SOFTWARE' | 'LICENSE';
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  payloadRef?: string;
  payloadChecksum?: string;
  errorMessage?: string;
}): Promise<void> {
  await params.pool.query(
    `INSERT INTO sync_events (
        direction,
        payload_type,
        status,
        payload_ref,
        payload_checksum,
        error_message,
        attempted_at,
        completed_at
      ) VALUES (
        $1::sync_direction,
        $2::sync_payload_type,
        $3::sync_status,
        $4,
        $5,
        $6,
        now(),
        CASE WHEN $3::sync_status IN ('COMPLETED', 'FAILED') THEN now() ELSE NULL END
      )`,
    [
      params.direction,
      params.payloadType,
      params.status,
      params.payloadRef ?? null,
      params.payloadChecksum ?? null,
      params.errorMessage ?? null,
    ],
  );
}
