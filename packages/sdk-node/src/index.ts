// @claimflow/sdk-node — typed Node/TypeScript client for the ClaimFlow API.
//
// The `types` namespace is generated from docs/openapi.yaml (the source of
// truth); the client and error classes are thin, stable, hand-written wrappers.
export { ClaimFlowClient } from './client.js';
export type {
  ClaimFlowClientOptions,
  OAuthCredentials,
  ScoreClaimRequest,
  ClaimScoreResult,
  BatchSubmitRequest,
  ClaimBatchAccepted,
  ClaimBatchStatus,
  CreateClaimRequest,
  ClaimSummary,
} from './client.js';
export { ClaimFlowError } from './errors.js';
export type { ApiErrorDetail } from './errors.js';
export type { components, paths, operations } from './generated/types.js';
