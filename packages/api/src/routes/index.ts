import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import authRoutes from './auth.js';
import claimsRoutes from './claims.js';
import scoreRoutes from './score.js';
import auditRoutes from './audit.js';
import documentsRoutes from './documents.js';
import extractionRoutes from './extraction.js';
import dashboardRoutes from './dashboard.js';
import adminRoutes from './admin.js';
import payerRoutes from './payers.js';
import webhookRoutes from './webhooks.js';
import caseRoutes from './cases.js';
import preauthorizationRoutes from './preauthorizations.js';

const apiRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1', async () => ({
    service: 'claimflow-api',
    version: 'v1',
  }));

  await fastify.register(authRoutes);
  await fastify.register(claimsRoutes);
  await fastify.register(scoreRoutes);
  await fastify.register(auditRoutes);
  await fastify.register(documentsRoutes);
  await fastify.register(extractionRoutes);
  await fastify.register(dashboardRoutes);
  await fastify.register(adminRoutes);
  await fastify.register(payerRoutes);
  await fastify.register(webhookRoutes);
  await fastify.register(caseRoutes);
  await fastify.register(preauthorizationRoutes);
};

export default fp(apiRoutes, {
  name: 'api-routes',
});

