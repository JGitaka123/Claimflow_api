import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { getPrivilegedPool } from '../db/privileged.js';

/**
 * /health is a cheap liveness probe (no I/O) — answers "is the process alive?".
 * /health/ready is a readiness probe that pings the DB (item 7): if Postgres is
 * unreachable, return 503 so orchestrators (K8s, load balancers) stop sending
 * traffic. The check is bounded with a short timeout so a flaky DB doesn't pile
 * readiness probes onto Postgres.
 */
const READINESS_TIMEOUT_MS = 2_000;

async function pingDb(pool: ReturnType<typeof getPrivilegedPool>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('db-readiness-timeout')), timeoutMs);
  });
  try {
    await Promise.race([pool.query('SELECT 1'), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  fastify.get('/health/ready', async (request, reply) => {
    try {
      const pool = getPrivilegedPool(fastify.config);
      await pingDb(pool, READINESS_TIMEOUT_MS);
      return { status: 'ready', timestamp: new Date().toISOString(), checks: { db: 'ok' } };
    } catch (err) {
      request.log.warn({ err }, 'readiness probe failed: db not reachable');
      return reply.code(503).send({
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        checks: { db: 'fail' },
      });
    }
  });
};

export default fp(healthRoutes, {
  name: 'health-routes',
});
