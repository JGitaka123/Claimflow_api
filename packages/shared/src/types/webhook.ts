// ============================================================================
// WEBHOOK TYPES — signed event delivery
// ============================================================================

export enum WebhookEventType {
  /** Emitted when an audit/score decision is not PASSED (FAILED or WARNING). */
  CLAIM_FLAGGED = 'claim.flagged',
  /** Emitted when an investigation case changes status (item 5). */
  CASE_STATUS_CHANGED = 'case.status_changed',
}

export enum WebhookDeliveryStatus {
  PENDING = 'PENDING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  EXHAUSTED = 'EXHAUSTED',
}

export interface WebhookEndpoint {
  id: string;
  tenantId: string;
  url: string;
  events: string[];
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present only in the response to endpoint creation. */
  secret?: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventType: string;
  eventId: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  responseStatus: number | null;
  error: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

/** Signature header name carried on every delivery. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-claimflow-signature';
