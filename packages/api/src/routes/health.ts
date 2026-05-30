import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  fastify.get('/health/ready', async () => ({
    status: 'ready',
    timestamp: new Date().toISOString(),
  }));
};

export default fp(healthRoutes, {
  name: 'health-routes',
});
