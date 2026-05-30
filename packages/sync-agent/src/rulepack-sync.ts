import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import type { Logger } from 'pino';
import type { Pool, QueryResultRow } from 'pg';
import { parse as parseYaml } from 'yaml';
import type { SyncAgentConfig } from './config.js';
import { insertSyncEvent } from './db.js';
import type { RulepackDownloadInput, RulepackSyncResult } from './types.js';

const REQUIRED_RULEPACK_FILES = [
  'manifest.yaml',
  'identity.yaml',
  'documentation.yaml',
  'clinical.yaml',
  'authorization.yaml',
  'financial.yaml',
  'structural.yaml',
] as const;

interface RulepackManifestLike {
  version?: string;
  sha_policy_version?: string;
  description?: string;
  rule_count?: number;
}

interface ExistingRulepackRow extends QueryResultRow {
  id: string;
}

interface InsertedRulepackRow extends QueryResultRow {
  id: string;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  normalized: string;
  prefixed: string;
}

interface ZipEntry {
  dir: boolean;
  name: string;
  async: (type: 'nodebuffer') => Promise<Buffer>;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeSha256(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, '');
}

export function parseSemver(value: string): ParsedSemver {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());

  if (!match) {
    throw new Error(`Invalid semantic version: ${value}`);
  }

  const majorRaw = match[1];
  const minorRaw = match[2];
  const patchRaw = match[3];

  if (!majorRaw || !minorRaw || !patchRaw) {
    throw new Error(`Invalid semantic version: ${value}`);
  }

  const major = Number.parseInt(majorRaw, 10);
  const minor = Number.parseInt(minorRaw, 10);
  const patch = Number.parseInt(patchRaw, 10);
  const normalized = `${major}.${minor}.${patch}`;

  return {
    major,
    minor,
    patch,
    normalized,
    prefixed: `v${normalized}`,
  };
}

async function ensureRulepackFiles(versionDir: string): Promise<void> {
  for (const fileName of REQUIRED_RULEPACK_FILES) {
    const candidate = path.join(versionDir, fileName);

    try {
      await readFile(candidate);
    } catch {
      throw new Error(`Rulepack bundle is missing required file: ${fileName}`);
    }
  }
}

async function extractRulepackZip(input: {
  zipBuffer: Buffer;
  destinationDir: string;
  tempDir: string;
}): Promise<void> {
  const zip = await JSZip.loadAsync(input.zipBuffer);

  await rm(input.tempDir, { recursive: true, force: true });
  await mkdir(input.tempDir, { recursive: true });

  const tempRoot = path.resolve(input.tempDir);
  const entries = Object.values(zip.files) as ZipEntry[];

  for (const entry of entries) {
    if (entry.dir) {
      continue;
    }

    const split = entry.name.split('/').filter((segment: string) => segment.length > 0);
    const withoutPrefix = split.length > 1 && /^v?\d+\.\d+\.\d+$/.test(split[0] ?? '') ? split.slice(1) : split;
    const relativePath = withoutPrefix.join(path.sep);

    if (relativePath.length === 0) {
      continue;
    }

    const targetPath = path.resolve(input.tempDir, relativePath);
    if (!targetPath.startsWith(`${tempRoot}${path.sep}`) && targetPath !== tempRoot) {
      throw new Error(`Invalid rulepack entry path: ${entry.name}`);
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    const fileBuffer = await entry.async('nodebuffer');
    await writeFile(targetPath, fileBuffer);
  }

  await ensureRulepackFiles(input.tempDir);

  await rm(input.destinationDir, { recursive: true, force: true });
  await rename(input.tempDir, input.destinationDir);
}

function readManifestOrThrow(content: string): RulepackManifestLike {
  const parsed = parseYaml(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Rulepack manifest is invalid YAML');
  }

  return parsed as RulepackManifestLike;
}

function computeSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export class RulepackSyncService {
  constructor(
    private readonly pool: Pool,
    private readonly config: SyncAgentConfig,
    private readonly logger: Logger,
  ) {}

  async syncRulepack(input: RulepackDownloadInput): Promise<RulepackSyncResult> {
    const parsedVersion = parseSemver(input.version);

    const existing = await this.pool.query<ExistingRulepackRow>(
      `SELECT id
         FROM rulepacks
        WHERE version_semver = $1
        LIMIT 1`,
      [parsedVersion.prefixed],
    );

    const storedPath = path.join(this.config.RULEPACK_DIR, parsedVersion.prefixed);

    if (existing.rows[0]) {
      this.logger.info({ version: parsedVersion.prefixed }, 'rulepack already present locally; skipping download');

      return {
        version: parsedVersion.prefixed,
        checksum: normalizeSha256(input.checksum),
        storedPath,
        inserted: false,
      };
    }

    await insertSyncEvent({
      pool: this.pool,
      direction: 'DOWN',
      payloadType: 'RULEPACK',
      status: 'IN_PROGRESS',
      payloadRef: parsedVersion.prefixed,
      payloadChecksum: normalizeSha256(input.checksum),
    });

    try {
      const resolvedDownloadUrl = new URL(input.downloadUrl, input.controlPlaneUrl).toString();
      const response = await fetch(resolvedDownloadUrl, {
        headers: {
          Authorization: `Bearer ${input.licenseToken}`,
          Accept: 'application/zip, application/octet-stream',
        },
      });

      if (!response.ok) {
        throw new Error(`Rulepack download failed with ${response.status}`);
      }

      const zipBuffer = Buffer.from(await response.arrayBuffer());
      const actualChecksum = computeSha256(zipBuffer);
      const expectedChecksum = normalizeSha256(input.checksum);

      if (actualChecksum !== expectedChecksum) {
        throw new Error(
          `Rulepack checksum mismatch for ${parsedVersion.prefixed}: expected ${expectedChecksum}, got ${actualChecksum}`,
        );
      }

      const tempDir = `${storedPath}.tmp-${Date.now()}`;
      await mkdir(this.config.RULEPACK_DIR, { recursive: true });
      await extractRulepackZip({
        zipBuffer,
        destinationDir: storedPath,
        tempDir,
      });

      const manifestPath = path.join(storedPath, 'manifest.yaml');
      const manifestContent = await readFile(manifestPath, 'utf8');
      const manifest = readManifestOrThrow(manifestContent);

      const manifestVersion = asNonEmptyString(manifest.version);
      if (!manifestVersion) {
        throw new Error('Rulepack manifest is missing version');
      }

      const parsedManifestVersion = parseSemver(manifestVersion);
      if (parsedManifestVersion.normalized !== parsedVersion.normalized) {
        throw new Error(
          `Rulepack version mismatch: expected ${parsedVersion.prefixed}, got ${parsedManifestVersion.prefixed}`,
        );
      }

      const ruleCount = asFiniteNumber(manifest.rule_count) ?? 0;

      const inserted = await this.pool.query<InsertedRulepackRow>(
        `INSERT INTO rulepacks (
            version_semver,
            version_major,
            version_minor,
            version_patch,
            sha_policy_version,
            description,
            rule_count,
            checksum,
            is_activated
          ) VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            false
          )
          ON CONFLICT (version_semver)
          DO NOTHING
          RETURNING id`,
        [
          parsedVersion.prefixed,
          parsedVersion.major,
          parsedVersion.minor,
          parsedVersion.patch,
          asNonEmptyString(manifest.sha_policy_version),
          asNonEmptyString(manifest.description),
          ruleCount,
          actualChecksum,
        ],
      );

      const insertedFlag = Boolean(inserted.rows[0]);

      await insertSyncEvent({
        pool: this.pool,
        direction: 'DOWN',
        payloadType: 'RULEPACK',
        status: 'COMPLETED',
        payloadRef: parsedVersion.prefixed,
        payloadChecksum: actualChecksum,
      });

      this.logger.info(
        {
          version: parsedVersion.prefixed,
          checksum: actualChecksum,
          storedPath,
          inserted: insertedFlag,
        },
        'new rulepack downloaded and staged for activation',
      );

      return {
        version: parsedVersion.prefixed,
        checksum: actualChecksum,
        storedPath,
        inserted: insertedFlag,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Rulepack sync failed';

      await insertSyncEvent({
        pool: this.pool,
        direction: 'DOWN',
        payloadType: 'RULEPACK',
        status: 'FAILED',
        payloadRef: parsedVersion.prefixed,
        payloadChecksum: normalizeSha256(input.checksum),
        errorMessage: message,
      });

      throw error;
    }
  }
}
