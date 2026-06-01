import { randomBytes } from 'node:crypto';
import {
  DomainError,
  ErrorCode,
  WebhookDeliveryStatus,
  type CreateWebhookEndpointInput,
  type WebhookDelivery,
  type WebhookEndpoint,
} from '@claimflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, QueryResultRow } from 'pg';
import type { Queryable, TenantDb } from '../db/client.js';
import { backoffSeconds, buildWebhookSignatureHeader } from '../integrations/webhook-signing.js';

const DEFAULT_MAX_ATTEMPTS = 6;
const DELIVERY_TIMEOUT_MS = 10_000;

interface EndpointRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  url: string;
  secret: string;
  events: string[];
  is_active: boolean;
  description: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface DeliveryRow extends QueryResultRow {
  id: string;
  endpoint_id: string;
  event_type: string;
  event_id: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  max_attempts: number;
  response_status: number | null;
  error: string | null;
  next_attempt_at: string | Date | null;
  created_at: string | Date;
  delivered_at: string | Date | null;
}

interface DueDeliveryRow extends DeliveryRow {
  url: string;
  secret: string;
  payload_json: unknown;
}

/** Result of an HTTP delivery attempt. */
export interface WebhookSendResult {
  status: number;
}

/** Injectable HTTP sender so the dispatcher is testable without real network I/O. */
export type WebhookSender = (input: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<WebhookSendResult>;

export interface DispatchResult {
  claimed: number;
  delivered: number;
  failed: number;
  exhausted: number;
}

function toIso(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    url: row.url,
    events: row.events,
    isActive: row.is_active,
    description: row.description,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

function mapDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventType: row.event_type,
    eventId: row.event_id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    responseStatus: row.response_status,
    error: row.error,
    nextAttemptAt: toIso(row.next_attempt_at),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    deliveredAt: toIso(row.delivered_at),
  };
}

/** Default sender: POST JSON via fetch with a hard timeout. */
export const fetchWebhookSender: WebhookSender = async ({ url, headers, body }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: controller.signal,
    });
    return { status: response.status };
  } finally {
    clearTimeout(timeout);
  }
};

async function markFailure(
  pool: Pool,
  row: DueDeliveryRow,
  attempt: number,
  error: string,
  responseStatus: number | null,
  result: DispatchResult,
): Promise<void> {
  if (attempt >= row.max_attempts) {
    await pool.query(
      `UPDATE webhook_deliveries
          SET status = 'EXHAUSTED'::webhook_delivery_status, attempts = $2,
              response_status = $3, error = $4, next_attempt_at = NULL
        WHERE id = $1::uuid`,
      [row.id, attempt, responseStatus, error],
    );
    result.exhausted += 1;
    return;
  }

  await pool.query(
    `UPDATE webhook_deliveries
        SET status = 'FAILED'::webhook_delivery_status, attempts = $2,
            response_status = $3, error = $4,
            next_attempt_at = now() + ($5::int * INTERVAL '1 second')
      WHERE id = $1::uuid`,
    [row.id, attempt, responseStatus, error, backoffSeconds(attempt)],
  );
  result.failed += 1;
}

const ENDPOINT_COLUMNS =
  'id, tenant_id, url, secret, events, is_active, description, created_at, updated_at';

export interface WebhookService {
  createEndpoint: (tenantId: string, input: CreateWebhookEndpointInput) => Promise<WebhookEndpoint>;
  listEndpoints: (tenantId: string) => Promise<WebhookEndpoint[]>;
  deleteEndpoint: (tenantId: string, endpointId: string) => Promise<void>;
  listDeliveries: (tenantId: string, endpointId: string, limit?: number) => Promise<WebhookDelivery[]>;
  enqueueEvent: (
    executor: Queryable,
    tenantId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ) => Promise<number>;
  // Cross-tenant background relay: runs on the privileged pool passed in by the
  // worker (RLS would otherwise hide other tenants' due deliveries). Not on the
  // tenant request path.
  dispatchDueDeliveries: (
    privilegedPool: Pool,
    options?: { limit?: number; sender?: WebhookSender },
  ) => Promise<DispatchResult>;
}

export function createWebhookService(pool: TenantDb, logger: FastifyBaseLogger): WebhookService {
  return {
    async createEndpoint(tenantId, input): Promise<WebhookEndpoint> {
      const secret = `whsec_${randomBytes(24).toString('hex')}`;
      const result = await pool.query<EndpointRow>(
        `INSERT INTO webhook_endpoints (tenant_id, url, secret, events, description)
         VALUES ($1::uuid, $2, $3, $4::text[], $5)
         RETURNING ${ENDPOINT_COLUMNS}`,
        [tenantId, input.url, secret, input.events, input.description ?? null],
      );

      const row = result.rows[0];
      if (!row) {
        throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to create webhook endpoint');
      }

      // Secret is returned only here, never on subsequent reads.
      return { ...mapEndpoint(row), secret };
    },

    async listEndpoints(tenantId): Promise<WebhookEndpoint[]> {
      const result = await pool.query<EndpointRow>(
        `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE tenant_id = $1::uuid ORDER BY created_at DESC`,
        [tenantId],
      );
      return result.rows.map(mapEndpoint);
    },

    async deleteEndpoint(tenantId, endpointId): Promise<void> {
      const result = await pool.query(
        `DELETE FROM webhook_endpoints WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [endpointId, tenantId],
      );
      if (result.rowCount === 0) {
        throw new DomainError(ErrorCode.NOT_FOUND, 'Webhook endpoint not found');
      }
    },

    async listDeliveries(tenantId, endpointId, limit = 50): Promise<WebhookDelivery[]> {
      const result = await pool.query<DeliveryRow>(
        `SELECT d.id, d.endpoint_id, d.event_type, d.event_id, d.status, d.attempts,
                d.max_attempts, d.response_status, d.error, d.next_attempt_at, d.created_at, d.delivered_at
           FROM webhook_deliveries d
           JOIN webhook_endpoints e ON e.id = d.endpoint_id
          WHERE d.endpoint_id = $1::uuid AND e.tenant_id = $2::uuid
          ORDER BY d.created_at DESC
          LIMIT $3`,
        [endpointId, tenantId, Math.min(Math.max(limit, 1), 200)],
      );
      return result.rows.map(mapDelivery);
    },

    async enqueueEvent(executor, tenantId, eventType, payload): Promise<number> {
      const endpoints = await executor.query<{ id: string }>(
        `SELECT id FROM webhook_endpoints
          WHERE tenant_id = $1::uuid AND is_active = true AND $2 = ANY(events)`,
        [tenantId, eventType],
      );

      if (endpoints.rows.length === 0) {
        return 0;
      }

      const body = JSON.stringify(payload);
      let created = 0;

      for (const endpoint of endpoints.rows) {
        await executor.query(
          `INSERT INTO webhook_deliveries
             (tenant_id, endpoint_id, event_type, payload_json, status, max_attempts, next_attempt_at)
           VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, 'PENDING'::webhook_delivery_status, $5, now())`,
          [tenantId, endpoint.id, eventType, body, DEFAULT_MAX_ATTEMPTS],
        );
        created += 1;
      }

      return created;
    },

    async dispatchDueDeliveries(privilegedPool, options = {}): Promise<DispatchResult> {
      const sender = options.sender ?? fetchWebhookSender;
      const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);

      const due = await privilegedPool.query<DueDeliveryRow>(
        `SELECT d.*, e.url, e.secret
           FROM webhook_deliveries d
           JOIN webhook_endpoints e ON e.id = d.endpoint_id
          WHERE d.status IN ('PENDING'::webhook_delivery_status, 'FAILED'::webhook_delivery_status)
            AND d.attempts < d.max_attempts
            AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= now())
            AND e.is_active = true
          ORDER BY d.next_attempt_at ASC NULLS FIRST
          LIMIT $1`,
        [limit],
      );

      const result: DispatchResult = { claimed: due.rows.length, delivered: 0, failed: 0, exhausted: 0 };

      for (const row of due.rows) {
        const attempt = row.attempts + 1;
        const rawBody = JSON.stringify({
          id: row.event_id,
          type: row.event_type,
          createdAt: new Date().toISOString(),
          data: row.payload_json,
        });
        const signature = buildWebhookSignatureHeader(row.secret, rawBody);

        try {
          const sendResult = await sender({
            url: row.url,
            headers: { 'x-claimflow-signature': signature, 'x-claimflow-event': row.event_type },
            body: rawBody,
          });

          if (sendResult.status >= 200 && sendResult.status < 300) {
            await privilegedPool.query(
              `UPDATE webhook_deliveries
                  SET status = 'DELIVERED'::webhook_delivery_status, attempts = $2,
                      response_status = $3, delivered_at = now(), error = NULL, next_attempt_at = NULL
                WHERE id = $1::uuid`,
              [row.id, attempt, sendResult.status],
            );
            result.delivered += 1;
            continue;
          }

          await markFailure(privilegedPool, row, attempt, `HTTP ${sendResult.status}`, sendResult.status, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'delivery_failed';
          await markFailure(privilegedPool, row, attempt, message.slice(0, 500), null, result);
          logger.warn({ deliveryId: row.id, err: error }, 'webhook delivery attempt failed');
        }
      }

      return result;
    },
  };
}
