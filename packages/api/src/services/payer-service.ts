import type { QueryResultRow } from 'pg';
import type { TenantDb } from '../db/client.js';
import { PayerStatus, type Payer } from '@claimflow/shared';

/** Raw `payers` row as returned by Postgres (snake_case columns). */
export interface PayerRow extends QueryResultRow {
  id: string;
  slug: string;
  name: string;
  short_name: string | null;
  status: string;
  rulepack_version: string | null;
  country_code: string;
  sort_order: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const SELECT_COLUMNS =
  'id, slug, name, short_name, status, rulepack_version, country_code, sort_order, created_at, updated_at';

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toPayerStatus(value: string): PayerStatus {
  if (
    value === PayerStatus.ACTIVE ||
    value === PayerStatus.COMING_SOON ||
    value === PayerStatus.INACTIVE
  ) {
    return value;
  }

  return PayerStatus.INACTIVE;
}

/** Pure mapper from a DB row to the shared `Payer` domain object. */
export function mapPayerRow(row: PayerRow): Payer {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    shortName: row.short_name,
    status: toPayerStatus(row.status),
    rulepackVersion: row.rulepack_version,
    countryCode: row.country_code,
    sortOrder: row.sort_order,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface ListPayersOptions {
  status?: PayerStatus;
  /** When false (default), INACTIVE payers are excluded from listings. */
  includeInactive?: boolean;
}

export interface PayerService {
  listPayers: (options?: ListPayersOptions) => Promise<Payer[]>;
  getPayerBySlug: (slug: string) => Promise<Payer | null>;
}

export function createPayerService(pool: TenantDb): PayerService {
  return {
    async listPayers(options: ListPayersOptions = {}): Promise<Payer[]> {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (options.status) {
        params.push(options.status);
        conditions.push(`status = $${params.length}::payer_status`);
      } else if (!options.includeInactive) {
        conditions.push(`status <> 'INACTIVE'::payer_status`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await pool.query<PayerRow>(
        `SELECT ${SELECT_COLUMNS} FROM payers ${where} ORDER BY sort_order ASC, name ASC`,
        params,
      );

      return result.rows.map(mapPayerRow);
    },

    async getPayerBySlug(slug: string): Promise<Payer | null> {
      const result = await pool.query<PayerRow>(
        `SELECT ${SELECT_COLUMNS} FROM payers WHERE slug = $1`,
        [slug],
      );

      const row = result.rows[0];
      return row ? mapPayerRow(row) : null;
    },
  };
}
