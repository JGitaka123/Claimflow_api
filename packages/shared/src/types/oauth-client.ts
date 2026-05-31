// ============================================================================
// OAUTH2 CLIENT TYPES — tenant-scoped client-credentials clients
// ============================================================================

import { API_KEY_SCOPES } from './api-key.js';

/**
 * Scopes an OAuth client may hold — the same curated subset of RBAC permissions
 * as API keys (machine credentials share one scope vocabulary).
 */
export const OAUTH_CLIENT_SCOPES = API_KEY_SCOPES;

export type OAuthClientScope = (typeof OAUTH_CLIENT_SCOPES)[number];

/** The OAuth2 grant types this server supports. */
export const OAUTH_GRANT_TYPES = ['client_credentials'] as const;
export type OAuthGrantType = (typeof OAUTH_GRANT_TYPES)[number];

export interface OAuthClient {
  id: string;
  tenantId: string;
  name: string;
  clientId: string;
  scopes: string[];
  createdBy: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** Plaintext client secret — present only in the response to client creation. */
  clientSecret?: string;
}

/** RFC 6749 §5.1 successful token response. */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

/**
 * Claims carried by an OAuth2 client-credentials access token. `scope` is a
 * space-delimited list per RFC 6749; `cid` identifies the issuing client.
 */
export interface OAuthAccessTokenClaims {
  sub: string;
  tenantId: string;
  type: 'oauth_client';
  cid: string;
  scope: string;
}
