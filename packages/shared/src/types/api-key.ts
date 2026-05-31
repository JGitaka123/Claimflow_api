// ============================================================================
// API KEY TYPES — tenant-scoped machine credentials
// ============================================================================

import type { Permission } from './auth.js';

/** Scopes a key may hold — a curated subset of the RBAC permissions. */
export const API_KEY_SCOPES = [
  'claim:create',
  'audit:trigger',
  'export:evidence',
  'dashboard:view',
  'case:view',
  'case:manage',
  'system:settings',
] as const satisfies readonly Permission[];

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKey {
  id: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdBy: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** Plaintext key — present only in the response to key creation. */
  key?: string;
}
