import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from './config.js';
import metricsPlugin from './plugins/metrics.js';
import authPlugin from './plugins/auth.js';
import tenantPlugin from './plugins/tenant.js';
import usageMeteringPlugin from './plugins/usage-metering.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import healthRoutes from './routes/health.js';
import metricsRoutes from './routes/metrics.js';
import apiRoutes from './routes/index.js';
import { sanitizeLogObject } from './logging/sanitizer.js';
import { logContextMixin } from './logging/context.js';

export interface BuildServerOptions {
  config?: Config;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Pino mixin: auto-inject request-scoped fields (tenantId, userId,
      // principalId, requestId) into every log line, sourced from the
      // AsyncLocalStorage entered in the tenant plugin (item 7).
      mixin: logContextMixin,
      formatters: {
        log(object: Record<string, unknown>) {
          return sanitizeLogObject(object);
        },
      },
    },
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
  });

  app.decorate('config', config);
  app.decorate('appLogger', app.log);

  void app.register(cors, {
    origin: true,
    credentials: true,
  });

  void app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: {
      action: 'deny',
    },
    referrerPolicy: {
      policy: 'no-referrer',
    },
    noSniff: true,
    permittedCrossDomainPolicies: {
      permittedPolicies: 'none',
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  });

  void app.register(rateLimitPlugin, {
    config,
  });

  void app.register(multipart, {
    limits: {
      fileSize: config.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
      files: 1,
    },
  });

  // OAuth2 token requests are application/x-www-form-urlencoded (RFC 6749 §4.4).
  // Parse into a plain object; the route validates it with Zod. Dependency-free.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        const params = new URLSearchParams(typeof body === 'string' ? body : body.toString('utf8'));
        done(null, Object.fromEntries(params.entries()));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  void app.register(metricsPlugin);
  void app.register(authPlugin);
  void app.register(tenantPlugin);
  // Per-tenant/per-key metering + rate limit — after tenant binds the context.
  void app.register(usageMeteringPlugin, { config });
  void app.register(errorHandlerPlugin);

  void app.register(healthRoutes);
  void app.register(metricsRoutes);
  void app.register(apiRoutes);

  return app;
}

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const app = buildServer({ config });

  try {
    await app.listen({
      port: config.PORT,
      host: '0.0.0.0',
    });
  } catch (error) {
    app.log.error({ err: error }, 'Failed to start API server');
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void startServer();
}
