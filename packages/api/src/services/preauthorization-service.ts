import {
  CreatePreauthorizationSchema,
  DomainError,
  ErrorCode,
  PreauthorizationStatus,
  type CreatePreauthorizationInput,
  type PreauthorizationClaimValidation,
  type PreauthorizationRecord,
  type PreauthorizationServiceCode,
} from '@claimflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

interface PreauthorizationRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  facility_id: string;
  preauth_number: string;
  patient_sha_id: string;
  status: PreauthorizationStatus;
  valid_from: string | Date | null;
  valid_to: string | Date;
  approved_at: string | Date | null;
  source: string;
  metadata_json: Record<string, unknown>;
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface PreauthorizationLookupRow extends PreauthorizationRow {
  facility_code: string | null;
}

interface PreauthorizationServiceCodeRow extends QueryResultRow {
  sha_service_code: string;
  quantity_authorized: number | null;
  max_amount_kes: string | number | null;
}

interface ClaimPreauthorizationValidationRow extends QueryResultRow {
  id: string;
  facility_id: string;
  patient_sha_id: string | null;
  preauth_number: string | null;
  admission_date: string | Date;
  facility_code: string | null;
}

interface FacilityRow extends QueryResultRow {
  id: string;
}

interface UpsertPreauthorizationParams {
  tenantId: string;
  userId: string;
  requestId: string;
  body: CreatePreauthorizationInput & { facilityId: string };
}

interface GetPreauthorizationParams {
  tenantId: string;
  preauthNumber: string;
}

interface ValidateClaimPreauthorizationParams {
  tenantId: string;
  claimId: string;
}

interface UpsertPreauthorizationResult {
  record: PreauthorizationRecord;
  updated: boolean;
}

function toIso(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function toDateOnly(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

function toNumber(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }

  return typeof value === 'number' ? value : Number.parseFloat(value);
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
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

function mapPreauthorization(
  row: PreauthorizationRow,
  serviceCodes: PreauthorizationServiceCode[],
): PreauthorizationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    facilityId: row.facility_id,
    preauthNumber: row.preauth_number,
    patientShaId: row.patient_sha_id,
    status: row.status,
    validFrom: toDateOnly(row.valid_from),
    validTo: toDateOnly(row.valid_to) ?? new Date().toISOString().slice(0, 10),
    approvedAt: toIso(row.approved_at),
    source: row.source,
    metadata: row.metadata_json ?? {},
    serviceCodes,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

export class PreauthorizationService {
  constructor(
    private readonly pool: Pool,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async upsertPreauthorization(params: UpsertPreauthorizationParams): Promise<UpsertPreauthorizationResult> {
    const body = CreatePreauthorizationSchema.parse(params.body);
    const facilityId = body.facilityId;

    if (!facilityId) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'facilityId is required');
    }

    return withTransaction(this.pool, async (client) => {
      const facility = await client.query<FacilityRow>(
        `SELECT id
           FROM facilities
          WHERE id = $1::uuid
            AND tenant_id = $2::uuid
            AND is_active = true
          LIMIT 1`,
        [facilityId, params.tenantId],
      );

      if (!facility.rows[0]) {
        throw new DomainError(ErrorCode.NOT_FOUND, 'Facility not found for tenant', {
          field: 'facilityId',
        });
      }

      const existing = await client.query<PreauthorizationRow>(
        `SELECT *
           FROM preauthorizations
          WHERE tenant_id = $1::uuid
            AND preauth_number = $2
          LIMIT 1
          FOR UPDATE`,
        [params.tenantId, body.preauthNumber],
      );

      const existingRow = existing.rows[0];

      let persisted: PreauthorizationRow | undefined;

      if (existingRow) {
        const updateResult = await client.query<PreauthorizationRow>(
          `UPDATE preauthorizations
              SET facility_id = $3::uuid,
                  patient_sha_id = $4,
                  status = $5::preauthorization_status,
                  valid_from = $6::date,
                  valid_to = $7::date,
                  approved_at = $8::timestamptz,
                  source = $9,
                  metadata_json = $10::jsonb,
                  updated_at = now()
            WHERE tenant_id = $1::uuid
              AND preauth_number = $2
          RETURNING *`,
          [
            params.tenantId,
            body.preauthNumber,
            facilityId,
            body.patientShaId,
            body.status,
            body.validFrom ?? null,
            body.validTo,
            body.approvedAt ?? null,
            body.source,
            JSON.stringify(body.metadata ?? {}),
          ],
        );

        persisted = updateResult.rows[0];
      } else {
        const insertResult = await client.query<PreauthorizationRow>(
          `INSERT INTO preauthorizations (
              tenant_id,
              facility_id,
              preauth_number,
              patient_sha_id,
              status,
              valid_from,
              valid_to,
              approved_at,
              source,
              metadata_json,
              created_by
            ) VALUES (
              $1::uuid,
              $2::uuid,
              $3,
              $4,
              $5::preauthorization_status,
              $6::date,
              $7::date,
              $8::timestamptz,
              $9,
              $10::jsonb,
              $11::uuid
            )
            RETURNING *`,
          [
            params.tenantId,
            facilityId,
            body.preauthNumber,
            body.patientShaId,
            body.status,
            body.validFrom ?? null,
            body.validTo,
            body.approvedAt ?? null,
            body.source,
            JSON.stringify(body.metadata ?? {}),
            params.userId,
          ],
        );

        persisted = insertResult.rows[0];
      }

      if (!persisted) {
        throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to persist preauthorization record');
      }

      await client.query(
        `DELETE FROM preauthorization_service_codes
          WHERE preauthorization_id = $1::uuid`,
        [persisted.id],
      );

      const dedupedCodes = new Map<string, { quantityAuthorized: number | null; maxAmountKes: number | null }>();

      for (const serviceCode of body.serviceCodes) {
        const key = normalizeCode(serviceCode.shaServiceCode);
        dedupedCodes.set(key, {
          quantityAuthorized: serviceCode.quantityAuthorized ?? null,
          maxAmountKes: serviceCode.maxAmountKes ?? null,
        });
      }

      for (const [shaServiceCode, limits] of dedupedCodes.entries()) {
        await client.query(
          `INSERT INTO preauthorization_service_codes (
              preauthorization_id,
              sha_service_code,
              quantity_authorized,
              max_amount_kes
            ) VALUES (
              $1::uuid,
              $2,
              $3,
              $4
            )`,
          [persisted.id, shaServiceCode, limits.quantityAuthorized, limits.maxAmountKes],
        );
      }

      const action = existingRow ? 'PREAUTH_UPDATED' : 'PREAUTH_REGISTERED';

      await client.query(
        `INSERT INTO audit_trail (
            tenant_id,
            user_id,
            action,
            detail_json
          ) VALUES (
            $1::uuid,
            $2::uuid,
            $3::audit_action,
            $4::jsonb
          )`,
        [
          params.tenantId,
          params.userId,
          action,
          JSON.stringify({
            requestId: params.requestId,
            preauthId: persisted.id,
            preauthNumber: persisted.preauth_number,
            serviceCodeCount: dedupedCodes.size,
            status: persisted.status,
          }),
        ],
      );

      const mappedServiceCodes = Array.from(dedupedCodes.entries()).map(([shaServiceCode, limits]) => ({
        shaServiceCode,
        quantityAuthorized: limits.quantityAuthorized,
        maxAmountKes: limits.maxAmountKes,
      }));

      this.logger.info(
        {
          tenantId: params.tenantId,
          preauthNumber: persisted.preauth_number,
          updated: Boolean(existingRow),
          serviceCodeCount: mappedServiceCodes.length,
        },
        'preauthorization upserted',
      );

      return {
        record: mapPreauthorization(persisted, mappedServiceCodes),
        updated: Boolean(existingRow),
      };
    });
  }

  async getPreauthorizationByNumber(params: GetPreauthorizationParams): Promise<PreauthorizationRecord> {
    const result = await this.pool.query<PreauthorizationRow>(
      `SELECT *
         FROM preauthorizations
        WHERE tenant_id = $1::uuid
          AND preauth_number = $2
        LIMIT 1`,
      [params.tenantId, params.preauthNumber],
    );

    const row = result.rows[0];

    if (!row) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Preauthorization record not found');
    }

    const serviceCodes = await this.loadServiceCodes(row.id);
    return mapPreauthorization(row, serviceCodes);
  }

  async validateClaimPreauthorization(
    params: ValidateClaimPreauthorizationParams,
  ): Promise<PreauthorizationClaimValidation> {
    const claimResult = await this.pool.query<ClaimPreauthorizationValidationRow>(
      `SELECT
          c.id,
          c.facility_id,
          c.patient_sha_id,
          c.preauth_number,
          c.admission_date,
          f.sha_facility_code AS facility_code
         FROM claims c
         JOIN facilities f ON f.id = c.facility_id
        WHERE c.id = $1::uuid
          AND c.tenant_id = $2::uuid
        LIMIT 1`,
      [params.claimId, params.tenantId],
    );

    const claim = claimResult.rows[0];

    if (!claim) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Claim not found');
    }

    const lineResult = await this.pool.query<{ sha_service_code: string }>(
      `SELECT sha_service_code
         FROM claim_lines
        WHERE claim_id = $1::uuid`,
      [params.claimId],
    );

    const claimServiceCodes = Array.from(
      new Set(
        lineResult.rows
          .map((row) => row.sha_service_code)
          .filter((code) => typeof code === 'string' && code.trim().length > 0)
          .map((code) => normalizeCode(code)),
      ),
    );

    const preauthNumber = claim.preauth_number?.trim() ?? null;

    if (!preauthNumber) {
      return {
        claimId: claim.id,
        preauthNumber: null,
        recordFound: false,
        status: null,
        patientMatches: false,
        facilityMatches: false,
        notExpired: false,
        missingServiceCodes: claimServiceCodes,
        overallValid: false,
        reasons: ['claim_missing_preauth_number'],
      };
    }

    const preauthResult = await this.pool.query<PreauthorizationLookupRow>(
      `SELECT
          p.*, 
          f.sha_facility_code AS facility_code
         FROM preauthorizations p
         JOIN facilities f ON f.id = p.facility_id
        WHERE p.tenant_id = $1::uuid
          AND p.preauth_number = $2
        LIMIT 1`,
      [params.tenantId, preauthNumber],
    );

    const preauth = preauthResult.rows[0];

    if (!preauth) {
      return {
        claimId: claim.id,
        preauthNumber,
        recordFound: false,
        status: null,
        patientMatches: false,
        facilityMatches: false,
        notExpired: false,
        missingServiceCodes: claimServiceCodes,
        overallValid: false,
        reasons: ['preauth_record_not_found'],
      };
    }

    const serviceCodes = await this.loadServiceCodes(preauth.id);
    const authorizedCodes = new Set(serviceCodes.map((code) => normalizeCode(code.shaServiceCode)));

    const missingServiceCodes = claimServiceCodes.filter((code) => !authorizedCodes.has(code));

    const claimPatient = claim.patient_sha_id?.trim().toUpperCase() ?? '';
    const preauthPatient = preauth.patient_sha_id.trim().toUpperCase();
    const patientMatches = claimPatient.length > 0 && claimPatient === preauthPatient;

    const facilityMatches = preauth.facility_id === claim.facility_id ||
      (preauth.facility_code !== null && claim.facility_code !== null && preauth.facility_code === claim.facility_code);

    const admissionDate = new Date(
      claim.admission_date instanceof Date
        ? claim.admission_date.toISOString()
        : claim.admission_date,
    );

    const validTo = new Date(
      preauth.valid_to instanceof Date
        ? preauth.valid_to.toISOString()
        : preauth.valid_to,
    );

    const notExpired = validTo.getTime() >= admissionDate.getTime();
    const activeStatus = preauth.status === PreauthorizationStatus.ACTIVE;

    const reasons: string[] = [];

    if (!activeStatus) {
      reasons.push('preauth_not_active');
    }

    if (!patientMatches) {
      reasons.push(claimPatient.length === 0 ? 'claim_patient_missing' : 'patient_mismatch');
    }

    if (!facilityMatches) {
      reasons.push('facility_mismatch');
    }

    if (!notExpired) {
      reasons.push('preauth_expired');
    }

    if (missingServiceCodes.length > 0) {
      reasons.push('missing_service_coverage');
    }

    return {
      claimId: claim.id,
      preauthNumber,
      recordFound: true,
      status: preauth.status,
      patientMatches,
      facilityMatches,
      notExpired,
      missingServiceCodes,
      overallValid: reasons.length === 0,
      reasons,
    };
  }

  private async loadServiceCodes(preauthorizationId: string): Promise<PreauthorizationServiceCode[]> {
    const result = await this.pool.query<PreauthorizationServiceCodeRow>(
      `SELECT
          sha_service_code,
          quantity_authorized,
          max_amount_kes
         FROM preauthorization_service_codes
        WHERE preauthorization_id = $1::uuid
        ORDER BY sha_service_code ASC`,
      [preauthorizationId],
    );

    return result.rows.map((row) => ({
      shaServiceCode: row.sha_service_code,
      quantityAuthorized: row.quantity_authorized,
      maxAmountKes: toNumber(row.max_amount_kes),
    }));
  }
}

export function createPreauthorizationService(
  pool: Pool,
  logger: FastifyBaseLogger,
): PreauthorizationService {
  return new PreauthorizationService(pool, logger);
}


