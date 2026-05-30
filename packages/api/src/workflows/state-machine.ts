import {
  ClaimStatus,
  DomainError,
  ErrorCode,
  isValidTransition,
} from '@claimflow/shared';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

const OVERRIDE_APPROVER_ROLES = new Set(['supervisor', 'admin', 'super_admin']);

interface ClaimStateRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  status: ClaimStatus;
  version: number;
  updated_at: string | Date;
}

interface TransitionParams {
  claimId: string;
  tenantId: string;
  toStatus: ClaimStatus;
  userId: string;
  userRole?: string;
  metadata?: Record<string, unknown>;
}

interface OverrideRequestParams {
  claimId: string;
  tenantId: string;
  userId: string;
  reason: string;
}

interface OverrideApprovalParams {
  claimId: string;
  tenantId: string;
  userId: string;
  userRole: string;
  supervisorNotes?: string;
}

interface TransitionResult {
  id: string;
  tenantId: string;
  status: ClaimStatus;
  version: number;
  updatedAt: string;
}

interface StateChangeResult {
  from: ClaimStatus;
  to: ClaimStatus;
  claim: TransitionResult;
}

interface AuditTrailRow extends QueryResultRow {
  user_id: string | null;
  created_at: string | Date;
}

function toIsoString(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

async function withTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function loadClaimForUpdate(client: PoolClient, claimId: string, tenantId: string): Promise<ClaimStateRow> {
  const claimResult = await client.query<ClaimStateRow>(
    `SELECT id, tenant_id, status, version, updated_at
       FROM claims
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
      FOR UPDATE`,
    [claimId, tenantId],
  );

  const claim = claimResult.rows[0];

  if (!claim) {
    throw new DomainError(ErrorCode.NOT_FOUND, 'Claim not found');
  }

  return claim;
}

async function insertStateAudit(
  client: PoolClient,
  params: {
    tenantId: string;
    claimId: string;
    userId: string;
    from: ClaimStatus;
    to: ClaimStatus;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_trail (
        tenant_id,
        claim_id,
        user_id,
        action,
        from_state,
        to_state,
        detail_json
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'CLAIM_STATE_CHANGED'::audit_action,
        $4::claim_status,
        $5::claim_status,
        $6::jsonb
      )`,
    [
      params.tenantId,
      params.claimId,
      params.userId,
      params.from,
      params.to,
      JSON.stringify(params.metadata ?? {}),
    ],
  );
}

async function updateClaimStatus(
  client: PoolClient,
  params: { claimId: string; tenantId: string; toStatus: ClaimStatus },
): Promise<TransitionResult> {
  const updated = await client.query<ClaimStateRow>(
    `UPDATE claims
        SET status = $3::claim_status,
            version = version + 1,
            updated_at = now()
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
      RETURNING id, tenant_id, status, version, updated_at`,
    [params.claimId, params.tenantId, params.toStatus],
  );

  const row = updated.rows[0];

  if (!row) {
    throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to update claim status');
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    version: row.version,
    updatedAt: toIsoString(row.updated_at),
  };
}

async function ensureCorrectionsOrUploadsSinceLastCorrectionState(
  client: PoolClient,
  params: { claimId: string; tenantId: string },
): Promise<void> {
  const markerResult = await client.query<AuditTrailRow>(
    `SELECT created_at, user_id
       FROM audit_trail
      WHERE tenant_id = $1::uuid
        AND claim_id = $2::uuid
        AND action = 'CLAIM_STATE_CHANGED'::audit_action
        AND to_state = 'CORRECTIONS_IN_PROGRESS'::claim_status
      ORDER BY created_at DESC
      LIMIT 1`,
    [params.tenantId, params.claimId],
  );

  const marker = markerResult.rows[0];

  let documentCount = 0;
  let correctionCount = 0;

  if (marker) {
    const uploads = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM documents
        WHERE claim_id = $1::uuid
          AND uploaded_at > $2::timestamptz`,
      [params.claimId, marker.created_at],
    );

    const corrections = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM corrections c
         JOIN extracted_fields ef ON ef.id = c.extracted_field_id
        WHERE ef.claim_id = $1::uuid
          AND c.corrected_at > $2::timestamptz`,
      [params.claimId, marker.created_at],
    );

    documentCount = Number.parseInt(uploads.rows[0]?.count ?? '0', 10);
    correctionCount = Number.parseInt(corrections.rows[0]?.count ?? '0', 10);
  } else {
    const uploads = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM documents
        WHERE claim_id = $1::uuid`,
      [params.claimId],
    );

    const corrections = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM corrections c
         JOIN extracted_fields ef ON ef.id = c.extracted_field_id
        WHERE ef.claim_id = $1::uuid`,
      [params.claimId],
    );

    documentCount = Number.parseInt(uploads.rows[0]?.count ?? '0', 10);
    correctionCount = Number.parseInt(corrections.rows[0]?.count ?? '0', 10);
  }

  if (documentCount === 0 && correctionCount === 0) {
    throw new DomainError(
      ErrorCode.INVALID_STATE_TRANSITION,
      'At least one correction or new document upload is required before re-submission',
    );
  }
}

async function getOverrideRequesterUserId(
  client: PoolClient,
  params: { claimId: string; tenantId: string },
): Promise<string | null> {
  const requested = await client.query<AuditTrailRow>(
    `SELECT user_id, created_at
       FROM audit_trail
      WHERE tenant_id = $1::uuid
        AND claim_id = $2::uuid
        AND action = 'OVERRIDE_REQUESTED'::audit_action
      ORDER BY created_at DESC
      LIMIT 1`,
    [params.tenantId, params.claimId],
  );

  return requested.rows[0]?.user_id ?? null;
}

async function resolveAuditDecision(
  client: PoolClient,
  params: { claimId: string; metadata?: Record<string, unknown> },
): Promise<ClaimStatus> {
  const decisionFromMetadata = params.metadata?.decision;

  if (typeof decisionFromMetadata === 'string') {
    const normalized = decisionFromMetadata.toUpperCase();

    if (normalized === ClaimStatus.PASSED || normalized === ClaimStatus.FAILED || normalized === ClaimStatus.WARNING) {
      return normalized;
    }
  }

  const latestAudit = await client.query<{ decision: string | null }>(
    `SELECT decision::text AS decision
       FROM audit_sessions
      WHERE claim_id = $1::uuid
      ORDER BY started_at DESC
      LIMIT 1`,
    [params.claimId],
  );

  const decision = latestAudit.rows[0]?.decision;

  if (decision === ClaimStatus.PASSED || decision === ClaimStatus.FAILED || decision === ClaimStatus.WARNING) {
    return decision;
  }

  throw new DomainError(
    ErrorCode.INVALID_STATE_TRANSITION,
    'Unable to determine final decision for AUDIT_COMPLETE transition',
  );
}

export class StateMachineWorkflow {
  constructor(private readonly pool: Pool) {}

  async transitionClaim(params: TransitionParams): Promise<TransitionResult> {
    return withTransaction(this.pool, async (client) => {
      const result = await this.transitionWithinTransaction(client, params);
      return result.claim;
    });
  }

  async requestOverride(params: OverrideRequestParams): Promise<TransitionResult> {
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO audit_trail (
            tenant_id,
            claim_id,
            user_id,
            action,
            detail_json
          ) VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            'OVERRIDE_REQUESTED'::audit_action,
            $4::jsonb
          )`,
        [
          params.tenantId,
          params.claimId,
          params.userId,
          JSON.stringify({ reason: params.reason }),
        ],
      );

      const transitioned = await this.transitionWithinTransaction(client, {
        claimId: params.claimId,
        tenantId: params.tenantId,
        toStatus: ClaimStatus.OVERRIDE_PENDING,
        userId: params.userId,
        metadata: {
          reason: params.reason,
          source: 'override_request',
        },
      });

      return transitioned.claim;
    });
  }

  async approveOverride(params: OverrideApprovalParams): Promise<TransitionResult> {
    return withTransaction(this.pool, async (client) => {
      const transitioned = await this.transitionWithinTransaction(client, {
        claimId: params.claimId,
        tenantId: params.tenantId,
        toStatus: ClaimStatus.OVERRIDE_APPROVED,
        userId: params.userId,
        userRole: params.userRole,
        metadata: {
          supervisorNotes: params.supervisorNotes ?? null,
          source: 'override_approve',
        },
      });

      await client.query(
        `INSERT INTO audit_trail (
            tenant_id,
            claim_id,
            user_id,
            action,
            detail_json
          ) VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            'OVERRIDE_APPROVED'::audit_action,
            $4::jsonb
          )`,
        [
          params.tenantId,
          params.claimId,
          params.userId,
          JSON.stringify({ supervisorNotes: params.supervisorNotes ?? null }),
        ],
      );

      return transitioned.claim;
    });
  }

  private async transitionWithinTransaction(
    client: PoolClient,
    params: TransitionParams,
  ): Promise<StateChangeResult> {
    const claim = await loadClaimForUpdate(client, params.claimId, params.tenantId);
    const fromState = claim.status;

    if (!isValidTransition(fromState, params.toStatus)) {
      throw new DomainError(
        ErrorCode.INVALID_STATE_TRANSITION,
        `Invalid transition from ${fromState} to ${params.toStatus}`,
      );
    }

    if (
      fromState === ClaimStatus.CORRECTIONS_IN_PROGRESS &&
      params.toStatus === ClaimStatus.DOCUMENTS_UPLOADED
    ) {
      await ensureCorrectionsOrUploadsSinceLastCorrectionState(client, {
        claimId: params.claimId,
        tenantId: params.tenantId,
      });
    }

    if (fromState === ClaimStatus.OVERRIDE_PENDING && params.toStatus === ClaimStatus.OVERRIDE_APPROVED) {
      const normalizedRole = params.userRole?.toLowerCase();

      if (!normalizedRole || !OVERRIDE_APPROVER_ROLES.has(normalizedRole)) {
        throw new DomainError(ErrorCode.FORBIDDEN, 'Only supervisor or admin can approve overrides');
      }

      const requesterUserId = await getOverrideRequesterUserId(client, {
        claimId: params.claimId,
        tenantId: params.tenantId,
      });

      if (!requesterUserId) {
        throw new DomainError(
          ErrorCode.INVALID_STATE_TRANSITION,
          'Override request record not found for this claim',
        );
      }

      if (requesterUserId === params.userId) {
        throw new DomainError(
          ErrorCode.INVALID_STATE_TRANSITION,
          'Override approval must be performed by a different user',
        );
      }
    }

    const updated = await updateClaimStatus(client, {
      claimId: params.claimId,
      tenantId: params.tenantId,
      toStatus: params.toStatus,
    });

    await insertStateAudit(client, {
      tenantId: params.tenantId,
      claimId: params.claimId,
      userId: params.userId,
      from: fromState,
      to: params.toStatus,
      metadata: params.metadata,
    });

    if (params.toStatus === ClaimStatus.AUDIT_COMPLETE) {
      const finalStatus = await resolveAuditDecision(client, {
        claimId: params.claimId,
        metadata: params.metadata,
      });

      if (!isValidTransition(ClaimStatus.AUDIT_COMPLETE, finalStatus)) {
        throw new DomainError(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Invalid transition from AUDIT_COMPLETE to ${finalStatus}`,
        );
      }

      const finalUpdate = await updateClaimStatus(client, {
        claimId: params.claimId,
        tenantId: params.tenantId,
        toStatus: finalStatus,
      });

      await insertStateAudit(client, {
        tenantId: params.tenantId,
        claimId: params.claimId,
        userId: params.userId,
        from: ClaimStatus.AUDIT_COMPLETE,
        to: finalStatus,
        metadata: {
          ...(params.metadata ?? {}),
          autoTransition: true,
        },
      });

      return {
        from: fromState,
        to: finalStatus,
        claim: finalUpdate,
      };
    }

    return {
      from: fromState,
      to: params.toStatus,
      claim: updated,
    };
  }
}

export function createStateMachineWorkflow(pool: Pool): StateMachineWorkflow {
  return new StateMachineWorkflow(pool);
}
