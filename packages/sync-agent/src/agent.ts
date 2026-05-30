import PgBoss from 'pg-boss';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { SyncAgentConfig } from './config.js';
import { insertSyncEvent, resolveActiveRulepackVersion, resolveFacilityContext } from './db.js';
import { LicenseValidator } from './license-validator.js';
import { MetricsUploader } from './metrics-uploader.js';
import { RulepackSyncService } from './rulepack-sync.js';
import type { HeartbeatRequest, HeartbeatResponse } from './types.js';

const SYNC_HEARTBEAT_JOB = 'sync-heartbeat';

interface HeartbeatResponseData {
  licenseValid: boolean;
  licenseRenewToken?: string;
  updates: {
    rulepackAvailable?: {
      version: string;
      downloadUrl: string;
      checksum: string;
      changelog: string;
    };
    softwareAvailable?: {
      version: string;
      changelog: string;
      imageUrls: {
        api: string;
        web: string;
        ml: string;
      };
    };
    modelUpdates?: Array<{
      modelName: string;
      version: string;
      downloadUrl: string;
      checksum: string;
      requiresTier: string;
    }>;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseHeartbeatResponse(raw: unknown): HeartbeatResponseData {
  const root = asRecord(raw);
  const data = asRecord(root.data);
  const updates = asRecord(data.updates);

  const rulepackAvailableRaw = asRecord(updates.rulepackAvailable);
  const softwareAvailableRaw = asRecord(updates.softwareAvailable);

  const modelUpdatesRaw = Array.isArray(updates.modelUpdates)
    ? updates.modelUpdates.map((entry) => asRecord(entry))
    : undefined;

  return {
    licenseValid: data.licenseValid === true,
    licenseRenewToken: asNonEmptyString(data.licenseRenewToken),
    updates: {
      rulepackAvailable:
        asNonEmptyString(rulepackAvailableRaw.version) &&
        asNonEmptyString(rulepackAvailableRaw.downloadUrl) &&
        asNonEmptyString(rulepackAvailableRaw.checksum)
          ? {
              version: rulepackAvailableRaw.version as string,
              downloadUrl: rulepackAvailableRaw.downloadUrl as string,
              checksum: rulepackAvailableRaw.checksum as string,
              changelog: asNonEmptyString(rulepackAvailableRaw.changelog) ?? '',
            }
          : undefined,
      softwareAvailable:
        asNonEmptyString(softwareAvailableRaw.version) && asRecord(softwareAvailableRaw.imageUrls)
          ? {
              version: softwareAvailableRaw.version as string,
              changelog: asNonEmptyString(softwareAvailableRaw.changelog) ?? '',
              imageUrls: {
                api: asNonEmptyString(asRecord(softwareAvailableRaw.imageUrls).api) ?? '',
                web: asNonEmptyString(asRecord(softwareAvailableRaw.imageUrls).web) ?? '',
                ml: asNonEmptyString(asRecord(softwareAvailableRaw.imageUrls).ml) ?? '',
              },
            }
          : undefined,
      modelUpdates: modelUpdatesRaw
        ?.map((entry) => {
          const modelName = asNonEmptyString(entry.modelName);
          const version = asNonEmptyString(entry.version);
          const downloadUrl = asNonEmptyString(entry.downloadUrl);
          const checksum = asNonEmptyString(entry.checksum);

          if (!modelName || !version || !downloadUrl || !checksum) {
            return null;
          }

          return {
            modelName,
            version,
            downloadUrl,
            checksum,
            requiresTier: asNonEmptyString(entry.requiresTier) ?? 'PRO',
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    },
  };
}

export function buildSyncScheduleCron(intervalHours: number): string {
  if (intervalHours <= 0) {
    throw new Error(`Invalid sync interval: ${intervalHours}`);
  }

  if (intervalHours >= 24) {
    return '0 0 * * *';
  }

  return `0 */${intervalHours} * * *`;
}

export class SyncAgent {
  private readonly boss: PgBoss;
  private readonly metricsUploader: MetricsUploader;
  private readonly licenseValidator: LicenseValidator;
  private readonly rulepackSyncService: RulepackSyncService;
  private started = false;
  private activeLicenseToken: string | null;

  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
    private readonly config: SyncAgentConfig,
  ) {
    this.boss = new PgBoss({
      connectionString: config.DATABASE_URL,
      schema: 'pgboss',
    });

    this.metricsUploader = new MetricsUploader(pool, config);
    this.licenseValidator = new LicenseValidator(pool, config, logger);
    this.rulepackSyncService = new RulepackSyncService(pool, config, logger);
    this.activeLicenseToken = config.LICENSE_TOKEN ?? null;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.boss.start();
    await this.boss.work(SYNC_HEARTBEAT_JOB, async () => {
      await this.runSyncCycle();
    });

    const cron = buildSyncScheduleCron(this.config.SYNC_INTERVAL_HOURS);
    await this.boss.schedule(SYNC_HEARTBEAT_JOB, cron, {});
    await this.boss.send(SYNC_HEARTBEAT_JOB, { trigger: 'startup' });

    this.started = true;

    this.logger.info(
      {
        jobName: SYNC_HEARTBEAT_JOB,
        cron,
      },
      'sync-agent scheduler started',
    );
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    await this.boss.stop();
    this.started = false;
    this.logger.info('sync-agent scheduler stopped');
  }

  async runSyncCycle(): Promise<void> {
    if (!this.config.CONTROL_PLANE_URL) {
      this.logger.info('control plane URL is not configured; skipping sync cycle');
      return;
    }

    const facility = await resolveFacilityContext(this.pool);
    const token = this.activeLicenseToken ?? this.config.LICENSE_TOKEN;

    if (!token) {
      await insertSyncEvent({
        pool: this.pool,
        direction: 'UP',
        payloadType: 'LICENSE',
        status: 'FAILED',
        payloadRef: facility.facilityId,
        errorMessage: 'No LICENSE_TOKEN configured for sync agent',
      });

      this.logger.warn({ facilityId: facility.facilityId }, 'no license token configured; cannot sync');
      return;
    }

    const license = await this.licenseValidator.validateAndPersist({
      token,
      expectedFacilityId: facility.facilityId,
    });
    this.activeLicenseToken = license.token;

    const activeRulepackVersion = await resolveActiveRulepackVersion(this.pool);

    const metrics = await this.metricsUploader.collectMetrics({
      facility,
      governanceMode: this.config.SYNC_GOVERNANCE_MODE,
      activeRulepackVersion,
    });

    const heartbeatRequest: HeartbeatRequest = {
      facilityId: facility.facilityId,
      softwareVersion: this.config.SOFTWARE_VERSION,
      activeRulepackVersion,
      governanceMode: this.config.SYNC_GOVERNANCE_MODE,
      metrics,
    };

    await insertSyncEvent({
      pool: this.pool,
      direction: 'UP',
      payloadType: 'METRICS',
      status: 'IN_PROGRESS',
      payloadRef: facility.facilityId,
    });

    try {
      const heartbeatResponse = await this.sendHeartbeat(heartbeatRequest, this.activeLicenseToken);
      await this.processHeartbeatResponse(facility.facilityId, heartbeatResponse);

      await insertSyncEvent({
        pool: this.pool,
        direction: 'UP',
        payloadType: 'METRICS',
        status: 'COMPLETED',
        payloadRef: facility.facilityId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Heartbeat sync failed';

      await insertSyncEvent({
        pool: this.pool,
        direction: 'UP',
        payloadType: 'METRICS',
        status: 'FAILED',
        payloadRef: facility.facilityId,
        errorMessage: message,
      });

      this.logger.error(
        {
          err: error,
          facilityId: facility.facilityId,
        },
        'sync heartbeat failed',
      );
    }
  }

  private async sendHeartbeat(payload: HeartbeatRequest, licenseToken: string): Promise<HeartbeatResponseData> {
    const heartbeatUrl = new URL('/api/v1/sync/heartbeat', this.config.CONTROL_PLANE_URL).toString();

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.HEARTBEAT_TIMEOUT_MS);

    try {
      const response = await fetch(heartbeatUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${licenseToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Heartbeat request failed with status ${response.status}`);
      }

      const raw = (await response.json()) as HeartbeatResponse;
      return parseHeartbeatResponse(raw);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async processHeartbeatResponse(facilityId: string, response: HeartbeatResponseData): Promise<void> {
    if (response.licenseRenewToken) {
      const renewed = await this.licenseValidator.validateAndPersist({
        token: response.licenseRenewToken,
        expectedFacilityId: facilityId,
      });

      this.activeLicenseToken = renewed.token;

      await insertSyncEvent({
        pool: this.pool,
        direction: 'DOWN',
        payloadType: 'LICENSE',
        status: 'COMPLETED',
        payloadRef: facilityId,
      });

      this.logger.info({ facilityId, status: renewed.status }, 'license token renewed');
    }

    if (!response.licenseValid) {
      this.logger.warn({ facilityId }, 'control plane reports license as invalid');
    }

    const rulepackUpdate = response.updates.rulepackAvailable;
    if (rulepackUpdate && this.activeLicenseToken) {
      await this.rulepackSyncService.syncRulepack({
        controlPlaneUrl: this.config.CONTROL_PLANE_URL as string,
        downloadUrl: rulepackUpdate.downloadUrl,
        checksum: rulepackUpdate.checksum,
        version: rulepackUpdate.version,
        licenseToken: this.activeLicenseToken,
      });
    }

    if (response.updates.modelUpdates && response.updates.modelUpdates.length > 0) {
      this.logger.info(
        {
          facilityId,
          count: response.updates.modelUpdates.length,
          models: response.updates.modelUpdates.map((item) => ({
            model: item.modelName,
            version: item.version,
            requiresTier: item.requiresTier,
          })),
        },
        'model updates advertised by control plane',
      );
    }

    if (response.updates.softwareAvailable) {
      this.logger.info(
        {
          facilityId,
          version: response.updates.softwareAvailable.version,
          changelog: response.updates.softwareAvailable.changelog,
        },
        'software update advertised by control plane',
      );
    }
  }
}