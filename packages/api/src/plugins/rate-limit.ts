import fp from 'fastify-plugin';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';
import type { Config } from '../config.js';

interface RateLimitPluginOptions {
  config: Pick<Config, 'RATE_LIMIT_RPM'>;
}

const rateLimitPlugin: FastifyPluginAsync<RateLimitPluginOptions> = async (fastify, options) => {
  await fastify.register(fastifyRateLimit, {
    global: true,
    max: options.config.RATE_LIMIT_RPM,
    timeWindow: '1 minute',
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });

  fastify.addHook('onRoute', (routeOptions) => {
    if (!routeOptions.url.startsWith('/v1/auth/')) {
      return;
    }

    const existingConfig = (routeOptions.config ?? {}) as Record<string, unknown>;

    routeOptions.config = {
      ...existingConfig,
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
      },
    };
  });
};

export default fp(rateLimitPlugin, {
  name: 'rate-limit-plugin',
});

