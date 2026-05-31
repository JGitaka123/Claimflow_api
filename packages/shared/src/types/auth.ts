// ============================================================================
// AUTH TYPES — Section 18 (Authentication & Authorization)
// ============================================================================

export enum UserRole {
  SUPER_ADMIN = 'super_admin',
  ADMIN = 'admin',
  SUPERVISOR = 'supervisor',
  CLAIMS_OFFICER = 'claims_officer',
  AUDITOR = 'auditor',
  VIEWER = 'viewer',
}

export type Permission =
  | 'claim:create'
  | 'claim:update'
  | 'document:upload'
  | 'audit:trigger'
  | 'field:correct'
  | 'override:request'
  | 'override:approve'
  | 'export:evidence'
  | 'dashboard:view'
  | 'user:manage'
  | 'rulepack:activate'
  | 'audit_trail:view'
  | 'case:view'
  | 'case:manage'
  | 'system:settings';

/** RBAC Permission Matrix from Section 18 */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.SUPER_ADMIN]: [
    'claim:create', 'claim:update', 'document:upload', 'audit:trigger',
    'field:correct', 'override:request', 'override:approve', 'export:evidence',
    'dashboard:view', 'user:manage', 'rulepack:activate', 'audit_trail:view',
    'case:view', 'case:manage', 'system:settings',
  ],
  [UserRole.ADMIN]: [
    'claim:create', 'claim:update', 'document:upload', 'audit:trigger',
    'field:correct', 'override:request', 'override:approve', 'export:evidence',
    'dashboard:view', 'user:manage', 'rulepack:activate', 'audit_trail:view',
    'case:view', 'case:manage', 'system:settings',
  ],
  [UserRole.SUPERVISOR]: [
    'claim:create', 'claim:update', 'document:upload', 'audit:trigger',
    'field:correct', 'override:request', 'override:approve', 'export:evidence',
    'dashboard:view', 'audit_trail:view', 'case:view', 'case:manage',
  ],
  [UserRole.CLAIMS_OFFICER]: [
    'claim:create', 'claim:update', 'document:upload', 'audit:trigger',
    'field:correct', 'override:request', 'export:evidence', 'dashboard:view',
  ],
  [UserRole.AUDITOR]: [
    'audit:trigger', 'export:evidence', 'dashboard:view', 'audit_trail:view',
    'case:view', 'case:manage',
  ],
  [UserRole.VIEWER]: [
    'dashboard:view',
  ],
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function hasAnyPermission(role: UserRole, permissions: Permission[]): boolean {
  return permissions.some(p => ROLE_PERMISSIONS[role].includes(p));
}

export interface User {
  id: string;
  tenantId: string;
  facilityId: string | null;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  failedLoginCount: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  passwordChangedAt: string;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthTokenPayload {
  sub: string;        // userId
  tid: string;        // tenantId
  fid: string | null; // facilityId
  role: UserRole;
  iat: number;
  exp: number;
}

export interface TenantContext {
  tenantId: string;
  facilityId: string | null;
  userId: string;
  role: UserRole;
}
