import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { MetricsRegistry } from '../plugins/metrics.js';
import type { AuthContext, TenantContext } from './request-context.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthContext | null;
    tenant: TenantContext | null;
  }

  interface FastifyInstance {
    config: Config;
    appLogger: FastifyBaseLogger;
    metricsRegistry: MetricsRegistry;
  }
}
