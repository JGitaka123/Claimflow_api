import pino from 'pino';
import { SyncAgent } from './agent.js';
import { loadSyncAgentConfig } from './config.js';
import { createPool } from './db.js';

export * from './agent.js';
export * from './config.js';
export * from './db.js';
export * from './license-validator.js';
export * from './metrics-uploader.js';
export * from './rulepack-sync.js';
export * from './types.js';

export async function startSyncAgent(): Promise<SyncAgent> {
  const config = loadSyncAgentConfig();
  const logger = pino({
    name: 'claimflow-sync-agent',
    level: config.LOG_LEVEL,
  });

  const pool = createPool(config);
  const agent = new SyncAgent(pool, logger, config);

  await agent.start();

  let isStopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (isStopping) {
      return;
    }

    isStopping = true;

    logger.info({ signal }, 'stopping sync-agent');

    try {
      await agent.stop();
      await pool.end();
      logger.info('sync-agent stopped cleanly');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'sync-agent shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void stop('SIGINT');
  });

  process.on('SIGTERM', () => {
    void stop('SIGTERM');
  });

  logger.info('sync-agent started');

  return agent;
}

if (require.main === module) {
  void startSyncAgent();
}