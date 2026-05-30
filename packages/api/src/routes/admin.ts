import fp from 'fastify-plugin';
import bcrypt from 'bcryptjs';
import { DomainError, ErrorCode, UserRole } from '@claimflow/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { QueryResultRow } from 'pg';
import { getPool } from '../db/client.js';
import { requirePermission, requireRole, requireStepUpMfa } from '../plugins/auth.js';

const ActivateRulepackParamsSchema = z.object({
  version: z.string().min(1).max(128),
});

const AuditTrailQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const ListUsersQuerySchema = z.object({
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((value) => {
      if (value === undefined) {
        return false;
      }

      if (typeof value === 'boolean') {
        return value;
      }

      return value === 'true';
    }),
});

const CreateUserBodySchema = z.object({
  email: z.string().email().max(255),
  displayName: z.string().min(1).max(120),
  role: z.nativeEnum(UserRole),
  facilityId: z.string().uuid().nullable().optional(),
  temporaryPassword: z.string().min(12).max(128),
});

const UpdateUserParamsSchema = z.object({
  userId: z.string().uuid(),
});

const UpdateUserBodySchema = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    role: z.nativeEnum(UserRole).optional(),
    isActive: z.boolean().optional(),
    facilityId: z.string().uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

const ResetPasswordBodySchema = z.object({
  temporaryPassword: z.string().min(12).max(128),
});

const ADMIN_AND_SUPER_ADMIN: UserRole[] = [
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
];

const AUDIT_TRAIL_VIEW_ROLES: UserRole[] = [
  UserRole.ADMIN,
  UserRole.SUPERVISOR,
  UserRole.AUDITOR,
];

interface ActivatedRulepackRow extends QueryResultRow {
  id: string;
  version_semver: string;
  checksum: string;
  activated_at: string | Date;
  activated_by: string;
}

interface AuditTrailRow extends QueryResultRow {
  id: string;
  claim_id: string | null;
  user_id: string | null;
  action: string;
  from_state: string | null;
  to_state: string | null;
  detail_json: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string | Date;
}

interface AdminUserRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  facility_id: string | null;
  email: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  must_change_password: boolean;
  last_login_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ExistsRow extends QueryResultRow {
  id: string;
}

function toIsoString(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toIsoStringOrNull(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }

  return toIsoString(value);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function mapAdminUser(row: AdminUserRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    facilityId: row.facility_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    lastLoginAt: toIsoStringOrNull(row.last_login_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function ensureCanManageSuperAdmin(actorRole: UserRole, targetRole: UserRole): void {
  if (targetRole === UserRole.SUPER_ADMIN && actorRole !== UserRole.SUPER_ADMIN) {
    throw new DomainError(ErrorCode.FORBIDDEN, 'Only super admin can assign super admin role');
  }
}

async function ensureFacilityBelongsToTenant(pool: ReturnType<typeof getPool>, tenantId: string, facilityId: string): Promise<void> {
  const facility = await pool.query<ExistsRow>(
    `SELECT id
       FROM facilities
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid`,
    [facilityId, tenantId],
  );

  if (!facility.rows[0]) {
    throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Facility does not belong to tenant', {
      field: 'facilityId',
    });
  }
}

async function getTenantUser(pool: ReturnType<typeof getPool>, tenantId: string, userId: string): Promise<AdminUserRow> {
  const userResult = await pool.query<AdminUserRow>(
    `SELECT
        id,
        tenant_id,
        facility_id,
        email,
        display_name,
        role,
        is_active,
        must_change_password,
        last_login_at,
        created_at,
        updated_at
       FROM users
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid`,
    [userId, tenantId],
  );

  const user = userResult.rows[0];

  if (!user) {
    throw new DomainError(ErrorCode.NOT_FOUND, 'User not found', {
      field: 'userId',
    });
  }

  return user;
}

const adminRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getPool(fastify.config);

  fastify.get('/v1/admin/users', {
    preHandler: [
      requireRole(...ADMIN_AND_SUPER_ADMIN),
      requirePermission('user:manage'),
    ],
  }, async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const query = ListUsersQuerySchema.parse(request.query ?? {});

    const result = await pool.query<AdminUserRow>(
      `SELECT
          id,
          tenant_id,
          facility_id,
          email,
          display_name,
          role,
          is_active,
          must_change_password,
          last_login_at,
          created_at,
          updated_at
         FROM users
        WHERE tenant_id = $1::uuid
          AND ($2::boolean OR is_active = true)
        ORDER BY created_at DESC`,
      [request.tenant.tenantId, query.includeInactive],
    );

    reply.send({
      data: {
        users: result.rows.map(mapAdminUser),
      },
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.post('/v1/admin/users', {
    preHandler: [
      requireRole(...ADMIN_AND_SUPER_ADMIN),
      requirePermission('user:manage'),
    ],
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const body = CreateUserBodySchema.parse(request.body ?? {});
    const email = normalizeEmail(body.email);

    ensureCanManageSuperAdmin(request.user.role, body.role);

    if (body.facilityId) {
      await ensureFacilityBelongsToTenant(pool, request.tenant.tenantId, body.facilityId);
    }

    const duplicateUser = await pool.query<ExistsRow>(
      `SELECT id
         FROM users
        WHERE tenant_id = $1::uuid
          AND email = $2`,
      [request.tenant.tenantId, email],
    );

    if (duplicateUser.rows[0]) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Email already exists', {
        field: 'email',
      });
    }

    const passwordHash = await bcrypt.hash(body.temporaryPassword, 12);

    const insertResult = await pool.query<AdminUserRow>(
      `INSERT INTO users (
          tenant_id,
          facility_id,
          email,
          display_name,
          password_hash,
          role,
          is_active,
          must_change_password,
          failed_login_count,
          password_changed_at
        ) VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          $4,
          $5,
          $6::user_role,
          true,
          true,
          0,
          now()
        )
        RETURNING
          id,
          tenant_id,
          facility_id,
          email,
          display_name,
          role,
          is_active,
          must_change_password,
          last_login_at,
          created_at,
          updated_at`,
      [
        request.tenant.tenantId,
        body.facilityId ?? null,
        email,
        body.displayName.trim(),
        passwordHash,
        body.role,
      ],
    );

    const createdUser = insertResult.rows[0];

    if (!createdUser || !request.user) {
      throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to create user');
    }

    await pool.query(
      `INSERT INTO audit_trail (
          tenant_id,
          user_id,
          action,
          detail_json,
          ip_address,
          user_agent
        ) VALUES (
          $1::uuid,
          $2::uuid,
          'USER_CREATED'::audit_action,
          $3::jsonb,
          $4::inet,
          $5
        )`,
      [
        request.tenant.tenantId,
        request.user.userId,
        JSON.stringify({
          targetUserId: createdUser.id,
          email: createdUser.email,
          role: createdUser.role,
        }),
        request.ip,
        request.headers['user-agent'] ?? null,
      ],
    );

    reply.code(201).send({
      data: {
        user: mapAdminUser(createdUser),
      },
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.patch('/v1/admin/users/:userId', {
    preHandler: [
      requireRole(...ADMIN_AND_SUPER_ADMIN),
      requirePermission('user:manage'),
    ],
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { userId } = UpdateUserParamsSchema.parse(request.params ?? {});
    const body = UpdateUserBodySchema.parse(request.body ?? {});

    const existingUser = await getTenantUser(pool, request.tenant.tenantId, userId);

    if (existingUser.role === UserRole.SUPER_ADMIN && request.user.role !== UserRole.SUPER_ADMIN) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Only super admin can modify super admin user');
    }

    if (request.user.userId === userId && body.isActive === false) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Cannot deactivate your own account', {
        field: 'isActive',
      });
    }

    if (body.role) {
      ensureCanManageSuperAdmin(request.user.role, body.role);
    }

    if (body.facilityId) {
      await ensureFacilityBelongsToTenant(pool, request.tenant.tenantId, body.facilityId);
    }

    const updates: string[] = [];
    const values: Array<string | boolean | null> = [];
    const changedFields: string[] = [];

    if (body.displayName !== undefined) {
      values.push(body.displayName.trim());
      updates.push(`display_name = $${values.length}`);
      changedFields.push('displayName');
    }

    if (body.role !== undefined) {
      values.push(body.role);
      updates.push(`role = $${values.length}::user_role`);
      changedFields.push('role');
    }

    if (body.isActive !== undefined) {
      values.push(body.isActive);
      updates.push(`is_active = $${values.length}`);
      changedFields.push('isActive');
    }

    if (Object.prototype.hasOwnProperty.call(body, 'facilityId')) {
      values.push(body.facilityId ?? null);
      updates.push(`facility_id = $${values.length}::uuid`);
      changedFields.push('facilityId');
    }

    updates.push('updated_at = now()');

    values.push(userId);
    values.push(request.tenant.tenantId);

    const userIdPosition = values.length - 1;
    const tenantIdPosition = values.length;

    const updateResult = await pool.query<AdminUserRow>(
      `UPDATE users
          SET ${updates.join(', ')}
        WHERE id = $${userIdPosition}::uuid
          AND tenant_id = $${tenantIdPosition}::uuid
        RETURNING
          id,
          tenant_id,
          facility_id,
          email,
          display_name,
          role,
          is_active,
          must_change_password,
          last_login_at,
          created_at,
          updated_at`,
      values,
    );

    const updatedUser = updateResult.rows[0];

    if (!updatedUser) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'User not found', {
        field: 'userId',
      });
    }

    await pool.query(
      `INSERT INTO audit_trail (
          tenant_id,
          user_id,
          action,
          detail_json,
          ip_address,
          user_agent
        ) VALUES (
          $1::uuid,
          $2::uuid,
          'USER_UPDATED'::audit_action,
          $3::jsonb,
          $4::inet,
          $5
        )`,
      [
        request.tenant.tenantId,
        request.user.userId,
        JSON.stringify({
          targetUserId: updatedUser.id,
          changedFields,
        }),
        request.ip,
        request.headers['user-agent'] ?? null,
      ],
    );

    reply.send({
      data: {
        user: mapAdminUser(updatedUser),
      },
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.post('/v1/admin/users/:userId/reset-password', {
    preHandler: [
      requireRole(...ADMIN_AND_SUPER_ADMIN),
      requirePermission('user:manage'),
      requireStepUpMfa(),
    ],
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { userId } = UpdateUserParamsSchema.parse(request.params ?? {});
    const body = ResetPasswordBodySchema.parse(request.body ?? {});

    const targetUser = await getTenantUser(pool, request.tenant.tenantId, userId);

    if (targetUser.role === UserRole.SUPER_ADMIN && request.user.role !== UserRole.SUPER_ADMIN) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Only super admin can reset super admin password');
    }

    const passwordHash = await bcrypt.hash(body.temporaryPassword, 12);

    await pool.query(
      `UPDATE users
          SET password_hash = $1,
              password_changed_at = now(),
              must_change_password = true,
              failed_login_count = 0,
              locked_until = NULL,
              updated_at = now()
        WHERE id = $2::uuid
          AND tenant_id = $3::uuid`,
      [passwordHash, userId, request.tenant.tenantId],
    );

    await pool.query(
      `INSERT INTO audit_trail (
          tenant_id,
          user_id,
          action,
          detail_json,
          ip_address,
          user_agent
        ) VALUES (
          $1::uuid,
          $2::uuid,
          'USER_PASSWORD_RESET'::audit_action,
          $3::jsonb,
          $4::inet,
          $5
        )`,
      [
        request.tenant.tenantId,
        request.user.userId,
        JSON.stringify({
          targetUserId: targetUser.id,
        }),
        request.ip,
        request.headers['user-agent'] ?? null,
      ],
    );

    reply.send({
      data: {
        userId: targetUser.id,
        mustChangePassword: true,
      },
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.post('/v1/admin/rulepacks/:version/activate', {
    preHandler: [
      requireRole(...ADMIN_AND_SUPER_ADMIN),
      requirePermission('rulepack:activate'),
      requireStepUpMfa(),
    ],
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { version } = ActivateRulepackParamsSchema.parse(request.params);

    await pool.query(
      `UPDATE rulepacks
          SET is_activated = false
        WHERE is_activated = true`,
    );

    const activatedResult = await pool.query<ActivatedRulepackRow>(
      `UPDATE rulepacks
          SET is_activated = true,
              activated_at = now(),
              activated_by = $2::uuid
        WHERE version_semver = $1
        RETURNING id, version_semver, checksum, activated_at, activated_by`,
      [version, request.user.userId],
    );

    const activated = activatedResult.rows[0];

    if (!activated) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Rulepack version not found', {
        field: 'version',
      });
    }

    await pool.query(
      `INSERT INTO audit_trail (
          tenant_id,
          user_id,
          action,
          detail_json,
          ip_address,
          user_agent
        ) VALUES (
          $1::uuid,
          $2::uuid,
          'RULEPACK_ACTIVATED'::audit_action,
          $3::jsonb,
          $4::inet,
          $5
        )`,
      [
        request.tenant.tenantId,
        request.user.userId,
        JSON.stringify({
          rulepackId: activated.id,
          version: activated.version_semver,
          checksum: activated.checksum,
        }),
        request.ip,
        request.headers['user-agent'] ?? null,
      ],
    );

    reply.send({
      data: {
        id: activated.id,
        version: activated.version_semver,
        checksum: activated.checksum,
        activatedAt: toIsoString(activated.activated_at),
        activatedBy: activated.activated_by,
      },
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.get('/v1/audit-trail', {
    preHandler: [
      requireRole(...AUDIT_TRAIL_VIEW_ROLES),
      requirePermission('audit_trail:view'),
    ],
  }, async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const query = AuditTrailQuerySchema.parse(request.query ?? {});

    const result = await pool.query<AuditTrailRow>(
      `SELECT
          id,
          claim_id,
          user_id,
          action::text AS action,
          from_state::text AS from_state,
          to_state::text AS to_state,
          detail_json,
          ip_address::text AS ip_address,
          user_agent,
          created_at
         FROM audit_trail
        WHERE tenant_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT $2`,
      [request.tenant.tenantId, query.limit],
    );

    reply.send({
      data: result.rows.map((row) => ({
        id: row.id,
        claimId: row.claim_id,
        userId: row.user_id,
        action: row.action,
        fromState: row.from_state,
        toState: row.to_state,
        detail: row.detail_json,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        createdAt: toIsoString(row.created_at),
      })),
      meta: {
        requestId: request.id,
      },
    });
  });
};

export default fp(adminRoutes, {
  name: 'admin-routes',
});
