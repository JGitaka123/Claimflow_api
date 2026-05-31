import { createHash } from 'node:crypto';
import {
  ClaimStatus,
  DomainError,
  ErrorCode,
  type ApiResponse,
  type Claim,
  type ClaimLine,
  type ClaimSummary,
  type ListClaimsQuery,
  type UpdateClaimInput,
  type CreateClaimInput,
} from '@claimflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

const MUTABLE_STATUSES = new Set<ClaimStatus>([ClaimStatus.DRAFT, ClaimStatus.CORRECTIONS_IN_PROGRESS]);

const SORT_COLUMN_MAP = {
  createdAt: 'c.created_at',
  updatedAt: 'c.updated_at',
  admissionDate: 'c.admission_date',
} as const;

interface CursorPayload {
  sortValue: string;
  id: string;
}

interface CreateClaimParams {
  tenantId: string;
  userId: string;
  requestId: string;
  body: CreateClaimInput;
  idempotencyKey?: string;
}

interface UpdateClaimParams {
  tenantId: string;
  userId: string;
  claimId: string;
  ifMatchVersion: number;
  body: UpdateClaimInput;
}

interface GetClaimParams {
  tenantId: string;
  claimId: string;
}

interface ListClaimsParams {
  tenantId: string;
  query: ListClaimsQuery;
}

interface CreateClaimResult {
  statusCode: number;
  payload: ApiResponse<{ claim: Claim; lines: ClaimLine[] }>;
  idempotentReplay: boolean;
}

interface ListClaimsResult {
  items: ClaimSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface ClaimDetailResult {
  claim: Claim;
  lines: ClaimLine[];
  documents: Array<Record<string, unknown>>;
  latestAuditSession: Record<string, unknown> | null;
}

interface ClaimRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  facility_id: string;
  payer_id: string | null;
  // Populated only on joined reads (list / detail); absent on INSERT/UPDATE RETURNING.
  payer_slug?: string | null;
  payer_name?: string | null;
  patient_sha_id: string | null;
  patient_name_enc: string | null;
  patient_national_id_enc: string | null;
  hmis_ref: string | null;
  claim_type: Claim['claimType'];
  visit_type: Claim['visitType'];
  admission_date: string | Date;
  discharge_date: string | Date | null;
  primary_diagnosis_code: string | null;
  sha_benefit_package: string | null;
  preauth_number: string | null;
  accommodation_type: string | null;
  patient_disposition: Claim['patientDisposition'];
  hospital_approved_total: string | number | null;
  status: ClaimStatus;
  version: number;
  last_audit_session_id: string | null;
  dedup_hash: string | null;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ClaimLineRow extends QueryResultRow {
  id: string;
  claim_id: string;
  line_number: number;
  sha_service_code: string;
  description: string;
  icd_code: string | null;
  procedure_code: string | null;
  case_code: string | null;
  quantity: number;
  unit_price: string | number;
  total_amount: string | number;
  bill_amount: string | number | null;
  preauth_number: string | null;
  status: string;
  validation_notes: string | null;
  created_at: string | Date;
}

interface ListClaimRow extends ClaimRow {
  document_count: number;
  line_count: number;
  total_amount: string | number;
  last_audit_decision: string | null;
}

interface IdempotencyRow extends QueryResultRow {
  response_status: number;
  response_body: ApiResponse<{ claim: Claim; lines: ClaimLine[] }>;
}

function toIsoString(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  return parsed.toISOString();
}

function toDateOnlyString(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return value.slice(0, 10);
}

function toNumber(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }

  return typeof value === 'number' ? value : Number.parseFloat(value);
}

function mapClaim(row: ClaimRow): Claim {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    facilityId: row.facility_id,
    payerId: row.payer_id,
    payerSlug: row.payer_slug ?? null,
    payerName: row.payer_name ?? null,
    patientShaId: row.patient_sha_id,
    patientName: row.patient_name_enc,
    patientNationalId: row.patient_national_id_enc,
    hmisRef: row.hmis_ref,
    claimType: row.claim_type,
    visitType: row.visit_type,
    admissionDate: toDateOnlyString(row.admission_date),
    dischargeDate: row.discharge_date ? toDateOnlyString(row.discharge_date) : null,
    primaryDiagnosisCode: row.primary_diagnosis_code,
    shaBenefitPackage: row.sha_benefit_package,
    preauthNumber: row.preauth_number,
    accommodationType: row.accommodation_type,
    patientDisposition: row.patient_disposition,
    hospitalApprovedTotal: toNumber(row.hospital_approved_total),
    status: row.status,
    version: row.version,
    lastAuditSessionId: row.last_audit_session_id,
    dedupHash: row.dedup_hash,
    createdBy: row.created_by,
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
  };
}

function mapClaimLine(row: ClaimLineRow): ClaimLine {
  return {
    id: row.id,
    claimId: row.claim_id,
    lineNumber: row.line_number,
    shaServiceCode: row.sha_service_code,
    description: row.description,
    icdCode: row.icd_code,
    procedureCode: row.procedure_code,
    caseCode: row.case_code,
    quantity: row.quantity,
    unitPrice: toNumber(row.unit_price) ?? 0,
    totalAmount: toNumber(row.total_amount) ?? 0,
    billAmount: toNumber(row.bill_amount),
    preauthNumber: row.preauth_number,
    status: row.status,
    validationNotes: row.validation_notes,
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
  };
}

function mapClaimSummary(row: ListClaimRow): ClaimSummary {
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    payerId: row.payer_id,
    payerSlug: row.payer_slug ?? null,
    claimType: row.claim_type,
    visitType: row.visit_type,
    hmisRef: row.hmis_ref,
    patientShaId: row.patient_sha_id,
    admissionDate: toDateOnlyString(row.admission_date),
    primaryDiagnosisCode: row.primary_diagnosis_code,
    documentCount: row.document_count,
    lineCount: row.line_count,
    lastAuditDecision: row.last_audit_decision,
    totalAmount: toNumber(row.total_amount) ?? 0,
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
  };
}

function buildDedupHash(input: {
  patientShaId?: string;
  facilityId: string;
  admissionDate: string;
  primaryDiagnosisCode?: string;
}): string {
  const normalized = [
    input.patientShaId?.trim().toUpperCase() ?? '',
    input.facilityId,
    input.admissionDate,
    input.primaryDiagnosisCode?.trim().toUpperCase() ?? '',
  ].join('|');

  return createHash('sha256').update(normalized).digest('hex');
}

function decodeCursor(rawCursor: string): CursorPayload {
  try {
    const decoded = Buffer.from(rawCursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { sortValue?: unknown }).sortValue === 'string' &&
      typeof (parsed as { id?: unknown }).id === 'string'
    ) {
      return parsed as CursorPayload;
    }
  } catch {
    // fallthrough
  }

  throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Invalid cursor value', {
    field: 'cursor',
  });
}

function encodeCursor(cursor: CursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
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

interface PayerLookupRow extends QueryResultRow {
  id: string;
  slug: string;
  name: string;
  status: string;
}

/**
 * Resolve the payer for a new claim. Defaults to the SHA payer when none is given.
 * Fails closed (400) on an unknown or non-ACTIVE payer so claims are never created
 * against a payer that cannot be audited.
 */
async function resolveClaimPayer(
  client: PoolClient,
  payerId: string | undefined,
): Promise<{ id: string; slug: string; name: string }> {
  if (payerId) {
    const result = await client.query<PayerLookupRow>(
      `SELECT id, slug, name, status::text AS status FROM payers WHERE id = $1::uuid`,
      [payerId],
    );

    const row = result.rows[0];

    if (!row) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Unknown payer', { field: 'payerId' });
    }

    if (row.status !== 'ACTIVE') {
      throw new DomainError(
        ErrorCode.VALIDATION_ERROR,
        `Payer '${row.slug}' is not active for new claims`,
        { field: 'payerId' },
      );
    }

    return { id: row.id, slug: row.slug, name: row.name };
  }

  const result = await client.query<PayerLookupRow>(
    `SELECT id, slug, name, status::text AS status FROM payers WHERE slug = 'sha'`,
  );

  const row = result.rows[0];

  if (!row) {
    throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Default SHA payer is not configured');
  }

  return { id: row.id, slug: row.slug, name: row.name };
}

async function attachPayerInfo(client: PoolClient | Pool, claim: Claim): Promise<void> {
  if (!claim.payerId) {
    return;
  }

  const result = await client.query<{ slug: string; name: string }>(
    `SELECT slug, name FROM payers WHERE id = $1::uuid`,
    [claim.payerId],
  );

  const row = result.rows[0];

  if (row) {
    claim.payerSlug = row.slug;
    claim.payerName = row.name;
  }
}

async function fetchClaimLines(client: PoolClient | Pool, claimId: string): Promise<ClaimLine[]> {
  const linesResult = await client.query<ClaimLineRow>(
    `SELECT *
       FROM claim_lines
      WHERE claim_id = $1::uuid
      ORDER BY line_number ASC`,
    [claimId],
  );

  return linesResult.rows.map(mapClaimLine);
}

export class ClaimService {
  constructor(
    private readonly pool: Pool,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async createClaim(params: CreateClaimParams): Promise<CreateClaimResult> {
    const { tenantId, userId, requestId, body, idempotencyKey } = params;

    this.logger.debug({ tenantId, userId, idempotencyKey }, 'create claim request');

    if (idempotencyKey) {
      const replay = await this.pool.query<IdempotencyRow>(
        `SELECT response_status, response_body
           FROM idempotency_keys
          WHERE idempotency_key = $1
            AND expires_at > now()`,
        [idempotencyKey],
      );

      if (replay.rowCount && replay.rows[0]) {
        return {
          statusCode: replay.rows[0].response_status,
          payload: replay.rows[0].response_body,
          idempotentReplay: true,
        };
      }
    }

    const dedupHash = buildDedupHash({
      patientShaId: body.patientShaId,
      facilityId: body.facilityId,
      admissionDate: body.admissionDate,
      primaryDiagnosisCode: body.primaryDiagnosisCode,
    });

    const created = await withTransaction(this.pool, async (client) => {
      const duplicate = await client.query<{ id: string }>(
        `SELECT id
           FROM claims
          WHERE tenant_id = $1::uuid
            AND dedup_hash = $2
          LIMIT 1`,
        [tenantId, dedupHash],
      );

      if (duplicate.rowCount) {
        throw new DomainError(ErrorCode.DUPLICATE_CLAIM, 'Duplicate claim detected');
      }

      const payer = await resolveClaimPayer(client, body.payerId);

      const claimInsert = await client.query<ClaimRow>(
        `INSERT INTO claims (
            tenant_id,
            facility_id,
            payer_id,
            patient_sha_id,
            patient_name_enc,
            patient_national_id_enc,
            hmis_ref,
            claim_type,
            visit_type,
            admission_date,
            discharge_date,
            primary_diagnosis_code,
            sha_benefit_package,
            preauth_number,
            accommodation_type,
            status,
            dedup_hash,
            created_by
          ) VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4,
            $5,
            $6,
            $7,
            $8::claim_type,
            $9::visit_type,
            $10::date,
            $11::date,
            $12,
            $13,
            $14,
            $15,
            'DRAFT'::claim_status,
            $16,
            $17::uuid
          )
          RETURNING *`,
        [
          tenantId,
          body.facilityId,
          payer.id,
          body.patientShaId ?? null,
          body.patientName ?? null,
          body.patientNationalId ?? null,
          body.hmisRef ?? null,
          body.claimType,
          body.visitType,
          body.admissionDate,
          body.dischargeDate ?? null,
          body.primaryDiagnosisCode ?? null,
          body.shaBenefitPackage ?? null,
          body.preauthNumber ?? null,
          body.accommodationType ?? null,
          dedupHash,
          userId,
        ],
      );

      const claimRow = claimInsert.rows[0];

      if (!claimRow) {
        throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Unable to create claim');
      }

      const insertedLines: ClaimLine[] = [];

      for (const [index, line] of (body.lines ?? []).entries()) {
        const totalAmount = line.quantity * line.unitPrice;

        const inserted = await client.query<ClaimLineRow>(
          `INSERT INTO claim_lines (
              claim_id,
              line_number,
              sha_service_code,
              description,
              icd_code,
              procedure_code,
              case_code,
              quantity,
              unit_price,
              total_amount,
              bill_amount,
              preauth_number,
              status
            ) VALUES (
              $1::uuid,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9,
              $10,
              $11,
              $12,
              'ACTIVE'
            )
            RETURNING *`,
          [
            claimRow.id,
            index + 1,
            line.shaServiceCode,
            line.description,
            line.icdCode ?? null,
            line.procedureCode ?? null,
            line.caseCode ?? null,
            line.quantity,
            line.unitPrice,
            totalAmount,
            line.billAmount ?? null,
            body.preauthNumber ?? null,
          ],
        );

        if (inserted.rows[0]) {
          insertedLines.push(mapClaimLine(inserted.rows[0]));
        }
      }

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
            'CLAIM_CREATED'::audit_action,
            $4::jsonb
          )`,
        [
          tenantId,
          claimRow.id,
          userId,
          JSON.stringify({
            source: 'api',
            requestId,
            lineCount: insertedLines.length,
          }),
        ],
      );

      const claim = mapClaim(claimRow);
      claim.payerSlug = payer.slug;
      claim.payerName = payer.name;
      claim.lines = insertedLines;

      const payload: ApiResponse<{ claim: Claim; lines: ClaimLine[] }> = {
        data: {
          claim,
          lines: insertedLines,
        },
        meta: {
          requestId,
        },
      };

      if (idempotencyKey) {
        await client.query(
          `INSERT INTO idempotency_keys (
              idempotency_key,
              response_status,
              response_body
            ) VALUES ($1, $2, $3::jsonb)
            ON CONFLICT (idempotency_key) DO NOTHING`,
          [idempotencyKey, 201, JSON.stringify(payload)],
        );
      }

      return payload;
    });

    return {
      statusCode: 201,
      payload: created,
      idempotentReplay: false,
    };
  }

  async listClaims(params: ListClaimsParams): Promise<ListClaimsResult> {
    const { tenantId, query } = params;

    this.logger.debug({ tenantId, query }, 'list claims request');

    const sortColumn = SORT_COLUMN_MAP[query.sortBy];
    const sortOrder = query.sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const values: unknown[] = [tenantId];
    const whereClauses: string[] = ['c.tenant_id = $1::uuid'];

    const statuses = query.status
      ?.split(',')
      .map((status) => status.trim())
      .filter((status) => status.length > 0);

    if (statuses && statuses.length > 0) {
      values.push(statuses);
      whereClauses.push(`c.status::text = ANY($${values.length}::text[])`);
    }

    if (query.claimType) {
      values.push(query.claimType);
      whereClauses.push(`c.claim_type = $${values.length}::claim_type`);
    }

    if (query.facilityId) {
      values.push(query.facilityId);
      whereClauses.push(`c.facility_id = $${values.length}::uuid`);
    }

    if (query.dateFrom) {
      values.push(query.dateFrom);
      whereClauses.push(`c.admission_date >= $${values.length}::date`);
    }

    if (query.dateTo) {
      values.push(query.dateTo);
      whereClauses.push(`c.admission_date <= $${values.length}::date`);
    }

    if (query.q && query.q.trim().length > 0) {
      values.push(`%${query.q.trim()}%`);
      whereClauses.push(`(c.hmis_ref ILIKE $${values.length} OR c.patient_sha_id ILIKE $${values.length})`);
    }

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      values.push(cursor.sortValue);
      values.push(cursor.id);

      const valueIndex = values.length - 1;
      const idIndex = values.length;
      const op = sortOrder === 'ASC' ? '>' : '<';

      if (query.sortBy === 'admissionDate') {
        whereClauses.push(`(c.admission_date, c.id) ${op} ($${valueIndex}::date, $${idIndex}::uuid)`);
      } else {
        whereClauses.push(`(${sortColumn}, c.id) ${op} ($${valueIndex}::timestamptz, $${idIndex}::uuid)`);
      }
    }

    values.push(query.limit + 1);
    const limitIndex = values.length;

    const sql = `
      SELECT
        c.*,
        p.slug AS payer_slug,
        p.name AS payer_name,
        COALESCE(lines.line_count, 0)::int AS line_count,
        COALESCE(lines.total_amount, 0)::numeric AS total_amount,
        COALESCE(docs.document_count, 0)::int AS document_count,
        latest.decision::text AS last_audit_decision
      FROM claims c
      LEFT JOIN payers p ON p.id = c.payer_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS line_count,
          COALESCE(SUM(total_amount), 0) AS total_amount
        FROM claim_lines cl
        WHERE cl.claim_id = c.id
      ) lines ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS document_count
        FROM documents d
        WHERE d.claim_id = c.id
      ) docs ON true
      LEFT JOIN LATERAL (
        SELECT decision
        FROM audit_sessions a
        WHERE a.claim_id = c.id
        ORDER BY a.started_at DESC
        LIMIT 1
      ) latest ON true
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY ${sortColumn} ${sortOrder}, c.id ${sortOrder}
      LIMIT $${limitIndex}
    `;

    const result = await this.pool.query<ListClaimRow>(sql, values);

    const hasMore = result.rows.length > query.limit;
    const visibleRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;

    let nextCursor: string | null = null;

    if (hasMore && visibleRows.length > 0) {
      const tail = visibleRows[visibleRows.length - 1];

      if (tail) {
        const sortValue =
          query.sortBy === 'admissionDate'
            ? toDateOnlyString(tail.admission_date)
            : toIsoString(query.sortBy === 'createdAt' ? tail.created_at : tail.updated_at);

        if (sortValue) {
          nextCursor = encodeCursor({
            sortValue,
            id: tail.id,
          });
        }
      }
    }

    return {
      items: visibleRows.map(mapClaimSummary),
      nextCursor,
      hasMore,
    };
  }

  async getClaimDetail(params: GetClaimParams): Promise<ClaimDetailResult> {
    const { tenantId, claimId } = params;

    this.logger.debug({ tenantId, claimId }, 'get claim detail request');

    const claimResult = await this.pool.query<ClaimRow>(
      `SELECT c.*, p.slug AS payer_slug, p.name AS payer_name
         FROM claims c
         LEFT JOIN payers p ON p.id = c.payer_id
        WHERE c.id = $1::uuid
          AND c.tenant_id = $2::uuid
        LIMIT 1`,
      [claimId, tenantId],
    );

    const claimRow = claimResult.rows[0];

    if (!claimRow) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Claim not found');
    }

    const lines = await fetchClaimLines(this.pool, claimId);

    const documentsResult = await this.pool.query<QueryResultRow>(
      `SELECT
          d.id,
          d.doc_type,
          d.mime_type,
          d.page_count,
          d.processing_status,
          d.uploaded_at
        FROM documents d
        WHERE d.claim_id = $1::uuid
        ORDER BY d.uploaded_at DESC`,
      [claimId],
    );

    const latestAuditResult = await this.pool.query<QueryResultRow>(
      `SELECT
          a.id,
          a.decision,
          a.rulepack_version,
          a.total_rules,
          a.passed_count,
          a.failed_count,
          a.warning_count,
          a.incomplete_count,
          a.started_at,
          a.completed_at
        FROM audit_sessions a
        WHERE a.claim_id = $1::uuid
        ORDER BY a.started_at DESC
        LIMIT 1`,
      [claimId],
    );

    const claim = mapClaim(claimRow);
    claim.lines = lines;

    const documents = documentsResult.rows.map((row) => ({
      id: row.id,
      docType: row.doc_type,
      mimeType: row.mime_type,
      pageCount: row.page_count,
      processingStatus: row.processing_status,
      uploadedAt: row.uploaded_at,
    }));

    return {
      claim,
      lines,
      documents,
      latestAuditSession: latestAuditResult.rows[0] ?? null,
    };
  }

  async updateClaim(params: UpdateClaimParams): Promise<{ claim: Claim; lines: ClaimLine[] }> {
    const { tenantId, userId, claimId, ifMatchVersion, body } = params;

    this.logger.debug({ tenantId, userId, claimId, ifMatchVersion }, 'update claim request');

    return withTransaction(this.pool, async (client) => {
      const existingResult = await client.query<ClaimRow>(
        `SELECT *
           FROM claims
          WHERE id = $1::uuid
            AND tenant_id = $2::uuid
          FOR UPDATE`,
        [claimId, tenantId],
      );

      const existing = existingResult.rows[0];

      if (!existing) {
        throw new DomainError(ErrorCode.NOT_FOUND, 'Claim not found');
      }

      if (existing.version !== ifMatchVersion) {
        throw new DomainError(ErrorCode.CONCURRENCY_CONFLICT, 'Claim version mismatch');
      }

      if (!MUTABLE_STATUSES.has(existing.status)) {
        throw new DomainError(ErrorCode.INVALID_STATE_TRANSITION, 'Claim cannot be updated in current status');
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      const pushUpdate = (column: string, value: unknown): void => {
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      };

      if (body.patientShaId !== undefined) {
        pushUpdate('patient_sha_id', body.patientShaId ?? null);
      }

      if (body.patientName !== undefined) {
        pushUpdate('patient_name_enc', body.patientName ?? null);
      }

      if (body.patientNationalId !== undefined) {
        pushUpdate('patient_national_id_enc', body.patientNationalId ?? null);
      }

      if (body.hmisRef !== undefined) {
        pushUpdate('hmis_ref', body.hmisRef ?? null);
      }

      if (body.admissionDate !== undefined) {
        pushUpdate('admission_date', body.admissionDate);
      }

      if (body.dischargeDate !== undefined) {
        pushUpdate('discharge_date', body.dischargeDate ?? null);
      }

      if (body.primaryDiagnosisCode !== undefined) {
        pushUpdate('primary_diagnosis_code', body.primaryDiagnosisCode ?? null);
      }

      if (body.shaBenefitPackage !== undefined) {
        pushUpdate('sha_benefit_package', body.shaBenefitPackage ?? null);
      }

      if (body.preauthNumber !== undefined) {
        pushUpdate('preauth_number', body.preauthNumber ?? null);
      }

      if (body.accommodationType !== undefined) {
        pushUpdate('accommodation_type', body.accommodationType ?? null);
      }

      if (body.hospitalApprovedTotal !== undefined) {
        pushUpdate('hospital_approved_total', body.hospitalApprovedTotal);
      }

      const dedupHash = buildDedupHash({
        patientShaId: body.patientShaId ?? existing.patient_sha_id ?? undefined,
        facilityId: existing.facility_id,
        admissionDate: body.admissionDate ?? toDateOnlyString(existing.admission_date),
        primaryDiagnosisCode: body.primaryDiagnosisCode ?? existing.primary_diagnosis_code ?? undefined,
      });
      pushUpdate('dedup_hash', dedupHash);

      updates.push('version = version + 1');
      updates.push('updated_at = now()');

      values.push(claimId);
      values.push(tenantId);

      const updateSql = `
        UPDATE claims
           SET ${updates.join(', ')}
         WHERE id = $${values.length - 1}::uuid
           AND tenant_id = $${values.length}::uuid
         RETURNING *
      `;

      const updateResult = await client.query<ClaimRow>(updateSql, values);
      const updatedClaimRow = updateResult.rows[0];

      if (!updatedClaimRow) {
        throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to update claim');
      }

      if (body.lines) {
        await client.query('DELETE FROM claim_lines WHERE claim_id = $1::uuid', [claimId]);

        for (const [index, line] of body.lines.entries()) {
          const totalAmount = line.quantity * line.unitPrice;

          await client.query(
            `INSERT INTO claim_lines (
                claim_id,
                line_number,
                sha_service_code,
                description,
                icd_code,
                procedure_code,
                case_code,
                quantity,
                unit_price,
                total_amount,
                bill_amount,
                preauth_number,
                status
              ) VALUES (
                $1::uuid,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                'ACTIVE'
              )`,
            [
              claimId,
              index + 1,
              line.shaServiceCode,
              line.description,
              line.icdCode ?? null,
              line.procedureCode ?? null,
              line.caseCode ?? null,
              line.quantity,
              line.unitPrice,
              totalAmount,
              line.billAmount ?? null,
              updatedClaimRow.preauth_number,
            ],
          );
        }
      }

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
            'CLAIM_UPDATED'::audit_action,
            $4::jsonb
          )`,
        [
          tenantId,
          claimId,
          userId,
          JSON.stringify({
            fieldsUpdated: Object.keys(body),
          }),
        ],
      );

      const claim = mapClaim(updatedClaimRow);
      await attachPayerInfo(client, claim);
      const lines = await fetchClaimLines(client, claimId);
      claim.lines = lines;

      return {
        claim,
        lines,
      };
    });
  }
}

export function createClaimService(pool: Pool, logger: FastifyBaseLogger): ClaimService {
  return new ClaimService(pool, logger);
}

