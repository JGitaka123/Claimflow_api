import type { UserRole } from '@claimflow/shared';

export interface AuthContext {
  userId: string;
  tenantId: string;
  facilityId: string | null;
  role: UserRole;
  mfaVerifiedAt: number | null;
  token: string;
}

export interface TenantContext {
  tenantId: string;
  facilityId: string | null;
}

export interface QueryContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
  route?: string;
}
