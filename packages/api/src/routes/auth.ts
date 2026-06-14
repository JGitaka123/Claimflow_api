import fp from 'fastify-plugin';
import {
  ChangePasswordSchema,
  DomainError,
  ErrorCode,
  LoginSchema,
  MfaVerifySchema,
} from '@claimflow/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { getPrivilegedPool } from '../db/privileged.js';
import { createAuthService } from '../services/auth-service.js';

const TenantHeaderSchema = z.string().uuid();

const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const LogoutSchema = z.object({
  refreshToken: z.string().min(1),
});

const MfaSetupSchema = z.object({
  deviceName: z.string().max(120).optional(),
});

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getPrivilegedPool(fastify.config);
  const authService = createAuthService(pool, fastify.log, fastify.config);

  fastify.post('/v1/auth/login', async (request, reply) => {
    const body = LoginSchema.parse(request.body ?? {});

    const rawTenantHeader = request.headers['x-tenant-id'];
    const tenantHeader = Array.isArray(rawTenantHeader) ? rawTenantHeader[0] : rawTenantHeader;

    if (!tenantHeader) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'x-tenant-id header is required', {
        field: 'x-tenant-id',
      });
    }

    const tenantId = TenantHeaderSchema.parse(tenantHeader);

    let result;
    try {
      result = await authService.login({
        tenantId,
        email: body.email,
        password: body.password,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });
    } catch (err) {
      // Item 7: the lockout path throws UNAUTHORIZED with this message; tag the
      // counter so alerts can fire on a spike (then re-raise unchanged).
      if (err instanceof DomainError && err.code === ErrorCode.UNAUTHORIZED && /locked/i.test(err.message)) {
        fastify.metricsRegistry.recordAuthFailure('locked');
      }
      throw err;
    }
    if ('kind' in result && result.kind === 'invalid_credentials') {
      fastify.metricsRegistry.recordAuthFailure('password');
    }

    reply.send({
      data: result,
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.post('/v1/auth/mfa/verify', async (request, reply) => {
    const body = MfaVerifySchema.parse(request.body ?? {});

    let result;
    try {
      result = await authService.verifyMfa({
        mfaToken: body.mfaToken,
        code: body.code,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });
    } catch (err) {
      // Item 7: tag the failure for the auth-anomaly counter and re-raise.
      if (err instanceof DomainError && err.code === ErrorCode.UNAUTHORIZED && /mfa/i.test(err.message)) {
        fastify.metricsRegistry.recordAuthFailure('mfa');
      }
      throw err;
    }

    reply.send({
      data: result,
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.post('/v1/auth/refresh', async (request, reply) => {
    const body = RefreshSchema.parse(request.body ?? {});

    const result = await authService.refreshSession({
      refreshToken: body.refreshToken,
    });

    reply.send({
      data: result,
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.post('/v1/auth/logout', async (request, reply) => {
    const body = LogoutSchema.parse(request.body ?? {});

    const result = await authService.logout({
      refreshToken: body.refreshToken,
    });

    reply.send({
      data: result,
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.get('/v1/auth/me', async (request, reply) => {
    if (!request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const user = await authService.getUserById({
      userId: request.user.userId,
      tenantId: request.user.tenantId,
    });

    reply.send({
      data: {
        user,
      },
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.post('/v1/auth/mfa/setup', async (request, reply) => {
    if (!request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const body = MfaSetupSchema.parse(request.body ?? {});
    const user = await authService.getUserById({
      userId: request.user.userId,
      tenantId: request.user.tenantId,
    });

    const result = await authService.setupMfa({
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      deviceName: body.deviceName,
    });

    reply.code(201).send({
      data: result,
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.post('/v1/auth/password/change', async (request, reply) => {
    if (!request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const body = ChangePasswordSchema.parse(request.body ?? {});

    await authService.changePassword({
      userId: request.user.userId,
      tenantId: request.user.tenantId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });

    reply.send({
      data: {
        success: true,
      },
      meta: {
        requestId: request.id,
      },
    });
  });
};

export default fp(authRoutes, {
  name: 'auth-routes',
});

