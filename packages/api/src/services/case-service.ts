import {
  CaseStatus,
  DomainError,
  ErrorCode,
  WebhookEventType,
  isValidCaseTransition,
  type CaseEvent,
  type CreateCaseInput,
  type InvestigationCase,
  type LinkClaimsInput,
  type ListCasesQuery,
  type TransitionCaseInput,
  type UpdateCaseInput,
} from '@claimflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { createWebhookService, type WebhookService } from './webhook-service.js';

const TERMINAL_STATUSES = new Set<CaseStatus>([CaseStatus.CLOSED, CaseStatus.DISMISSED]);

interface CaseRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  status: CaseStatus;
  priority: InvestigationCase['priority'];
  assigned_to: string | null;
  resolution: string | null;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
  closed_at: string | Date | null;
}

interface CaseEventRow extends QueryResultRow {
  id: string;
  case_id: string;
  user_id: string | null;
  action: string;
  detail_json: Record<string, unknown> | null;
  created_at: string | Date;
}

function toIso(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapCase(row: CaseRow): InvestigationCase {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignedTo: row.assigned_to,
    resolution: row.resolution,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
    closedAt: toIso(row.closed_at),
  };
}

function mapEvent(row: CaseEventRow): CaseEvent {
  return {
    id: row.id,
    caseId: row.case_id,
    userId: row.user_id,
    action: row.action,
    detail: row.detail_json ?? {},
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
}

const CASE_COLUMNS =
  'id, tenant_id, title, description, status, priority, assigned_to, resolution, created_by, created_at, updated_at, closed_at';

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

async function recordEvent(
  executor: Pool | PoolClient,
  tenantId: string,
  caseId: string,
  userId: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await executor.query(
    `INSERT INTO case_events (tenant_id, case_id, user_id, action, detail_json)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb)`,
    [tenantId, caseId, userId, action, JSON.stringify(detail)],
  );
}

async function assertClaimsInTenant(
  executor: Pool | PoolClient,
  tenantId: string,
  claimIds: string[],
): Promise<void> {
  if (claimIds.length === 0) {
    return;
  }

  const unique = [...new Set(claimIds)];
  const result = await executor.query<{ id: string }>(
    `SELECT id FROM claims WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
    [tenantId, unique],
  );

  if (result.rows.length !== unique.length) {
    throw new DomainError(ErrorCode.VALIDATION_ERROR, 'One or more claims were not found in this tenant', {
      field: 'claimIds',
    });
  }
}

async function linkClaimRows(
  executor: Pool | PoolClient,
  tenantId: string,
  caseId: string,
  userId: string,
  claimIds: string[],
): Promise<void> {
  for (const claimId of [...new Set(claimIds)]) {
    await executor.query(
      `INSERT INTO case_claims (case_id, claim_id, tenant_id, linked_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
       ON CONFLICT (case_id, claim_id) DO NOTHING`,
      [caseId, claimId, tenantId, userId],
    );
  }
}

export interface CaseService {
  createCase: (tenantId: string, userId: string, input: CreateCaseInput) => Promise<InvestigationCase>;
  listCases: (tenantId: string, query: ListCasesQuery) => Promise<InvestigationCase[]>;
  getCase: (tenantId: string, caseId: string) => Promise<InvestigationCase & { events: CaseEvent[] }>;
  updateCase: (tenantId: string, userId: string, caseId: string, input: UpdateCaseInput) => Promise<InvestigationCase>;
  transitionCase: (
    tenantId: string,
    userId: string,
    caseId: string,
    input: TransitionCaseInput,
  ) => Promise<InvestigationCase>;
  linkClaims: (tenantId: string, userId: string, caseId: string, input: LinkClaimsInput) => Promise<InvestigationCase>;
  unlinkClaim: (tenantId: string, userId: string, caseId: string, claimId: string) => Promise<void>;
}

async function loadCaseRow(
  executor: Pool | PoolClient,
  tenantId: string,
  caseId: string,
  forUpdate = false,
): Promise<CaseRow> {
  const result = await executor.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM investigation_cases WHERE id = $1::uuid AND tenant_id = $2::uuid${forUpdate ? ' FOR UPDATE' : ''}`,
    [caseId, tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new DomainError(ErrorCode.NOT_FOUND, 'Case not found');
  }
  return row;
}

async function attachLinkedClaims(
  executor: Pool | PoolClient,
  caseId: string,
  investigationCase: InvestigationCase,
): Promise<InvestigationCase> {
  const links = await executor.query<{ claim_id: string; linked_at: string | Date }>(
    `SELECT claim_id, linked_at FROM case_claims WHERE case_id = $1::uuid ORDER BY linked_at ASC`,
    [caseId],
  );
  investigationCase.linkedClaims = links.rows.map((row) => ({
    claimId: row.claim_id,
    linkedAt: toIso(row.linked_at) ?? new Date().toISOString(),
  }));
  return investigationCase;
}

export function createCaseService(pool: Pool, logger: FastifyBaseLogger): CaseService {
  const webhookService: WebhookService = createWebhookService(pool, logger);

  return {
    async createCase(tenantId, userId, input): Promise<InvestigationCase> {
      return withTransaction(pool, async (client) => {
        if (input.claimIds && input.claimIds.length > 0) {
          await assertClaimsInTenant(client, tenantId, input.claimIds);
        }

        const inserted = await client.query<CaseRow>(
          `INSERT INTO investigation_cases (tenant_id, title, description, priority, created_by)
           VALUES ($1::uuid, $2, $3, COALESCE($4::case_priority, 'MEDIUM'::case_priority), $5::uuid)
           RETURNING ${CASE_COLUMNS}`,
          [tenantId, input.title, input.description ?? null, input.priority ?? null, userId],
        );

        const row = inserted.rows[0];
        if (!row) {
          throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to create case');
        }

        if (input.claimIds && input.claimIds.length > 0) {
          await linkClaimRows(client, tenantId, row.id, userId, input.claimIds);
        }

        await recordEvent(client, tenantId, row.id, userId, 'CASE_CREATED', {
          title: input.title,
          claimCount: input.claimIds?.length ?? 0,
        });

        return attachLinkedClaims(client, row.id, mapCase(row));
      });
    },

    async listCases(tenantId, query): Promise<InvestigationCase[]> {
      const conditions = ['tenant_id = $1::uuid'];
      const values: unknown[] = [tenantId];

      if (query.status) {
        values.push(query.status);
        conditions.push(`status = $${values.length}::case_status`);
      }
      if (query.assignedTo) {
        values.push(query.assignedTo);
        conditions.push(`assigned_to = $${values.length}::uuid`);
      }

      values.push(query.limit);
      const result = await pool.query<CaseRow>(
        `SELECT ${CASE_COLUMNS} FROM investigation_cases
          WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT $${values.length}`,
        values,
      );
      return result.rows.map(mapCase);
    },

    async getCase(tenantId, caseId): Promise<InvestigationCase & { events: CaseEvent[] }> {
      const row = await loadCaseRow(pool, tenantId, caseId);
      const withClaims = await attachLinkedClaims(pool, caseId, mapCase(row));
      const events = await pool.query<CaseEventRow>(
        `SELECT id, case_id, user_id, action, detail_json, created_at
           FROM case_events WHERE case_id = $1::uuid ORDER BY created_at ASC`,
        [caseId],
      );
      return { ...withClaims, events: events.rows.map(mapEvent) };
    },

    async updateCase(tenantId, userId, caseId, input): Promise<InvestigationCase> {
      return withTransaction(pool, async (client) => {
        await loadCaseRow(client, tenantId, caseId, true);

        if (input.assignedTo) {
          const assignee = await client.query<{ id: string }>(
            `SELECT id FROM users WHERE id = $1::uuid AND tenant_id = $2::uuid`,
            [input.assignedTo, tenantId],
          );
          if (assignee.rows.length === 0) {
            throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Assignee not found in this tenant', {
              field: 'assignedTo',
            });
          }
        }

        const updates: string[] = [];
        const values: unknown[] = [];
        const set = (column: string, value: unknown): void => {
          values.push(value);
          updates.push(`${column} = $${values.length}`);
        };

        if (input.title !== undefined) set('title', input.title);
        if (input.description !== undefined) set('description', input.description);
        if (input.priority !== undefined) set('priority', input.priority);
        if (input.assignedTo !== undefined) set('assigned_to', input.assignedTo);
        if (input.resolution !== undefined) set('resolution', input.resolution);

        updates.push('updated_at = now()');
        values.push(caseId);
        values.push(tenantId);

        const result = await client.query<CaseRow>(
          `UPDATE investigation_cases SET ${updates.join(', ')}
            WHERE id = $${values.length - 1}::uuid AND tenant_id = $${values.length}::uuid
            RETURNING ${CASE_COLUMNS}`,
          values,
        );

        const row = result.rows[0];
        if (!row) {
          throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to update case');
        }

        await recordEvent(client, tenantId, caseId, userId, 'CASE_UPDATED', {
          fields: Object.keys(input),
        });

        return attachLinkedClaims(client, caseId, mapCase(row));
      });
    },

    async transitionCase(tenantId, userId, caseId, input): Promise<InvestigationCase> {
      const updated = await withTransaction(pool, async (client) => {
        const existing = await loadCaseRow(client, tenantId, caseId, true);

        if (existing.status === input.status) {
          throw new DomainError(ErrorCode.INVALID_STATE_TRANSITION, 'Case is already in the requested status');
        }

        if (!isValidCaseTransition(existing.status, input.status)) {
          throw new DomainError(
            ErrorCode.INVALID_STATE_TRANSITION,
            `Cannot transition case from ${existing.status} to ${input.status}`,
          );
        }

        const closedAtClause = TERMINAL_STATUSES.has(input.status) ? 'now()' : 'NULL';
        const result = await client.query<CaseRow>(
          `UPDATE investigation_cases
              SET status = $1::case_status, closed_at = ${closedAtClause}, updated_at = now()
            WHERE id = $2::uuid AND tenant_id = $3::uuid
            RETURNING ${CASE_COLUMNS}`,
          [input.status, caseId, tenantId],
        );

        const row = result.rows[0];
        if (!row) {
          throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to transition case');
        }

        await recordEvent(client, tenantId, caseId, userId, 'CASE_STATUS_CHANGED', {
          from: existing.status,
          to: input.status,
          note: input.note ?? null,
        });

        return { row, fromStatus: existing.status };
      });

      // Emit case.status_changed (best-effort; never fails the transition).
      try {
        await webhookService.enqueueEvent(pool, tenantId, WebhookEventType.CASE_STATUS_CHANGED, {
          caseId,
          fromStatus: updated.fromStatus,
          toStatus: input.status,
        });
      } catch (error) {
        logger.warn({ err: error, caseId }, 'failed to enqueue case.status_changed webhook');
      }

      return attachLinkedClaims(pool, caseId, mapCase(updated.row));
    },

    async linkClaims(tenantId, userId, caseId, input): Promise<InvestigationCase> {
      return withTransaction(pool, async (client) => {
        const row = await loadCaseRow(client, tenantId, caseId, true);
        await assertClaimsInTenant(client, tenantId, input.claimIds);
        await linkClaimRows(client, tenantId, caseId, userId, input.claimIds);
        await recordEvent(client, tenantId, caseId, userId, 'CASE_CLAIMS_LINKED', {
          claimIds: input.claimIds,
        });
        return attachLinkedClaims(client, caseId, mapCase(row));
      });
    },

    async unlinkClaim(tenantId, userId, caseId, claimId): Promise<void> {
      await withTransaction(pool, async (client) => {
        await loadCaseRow(client, tenantId, caseId, true);
        const result = await client.query(
          `DELETE FROM case_claims WHERE case_id = $1::uuid AND claim_id = $2::uuid`,
          [caseId, claimId],
        );
        if (result.rowCount === 0) {
          throw new DomainError(ErrorCode.NOT_FOUND, 'Claim is not linked to this case');
        }
        await recordEvent(client, tenantId, caseId, userId, 'CASE_CLAIM_UNLINKED', { claimId });
      });
    },
  };
}
