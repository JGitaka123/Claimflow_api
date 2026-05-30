import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verify as verifyJwt, type JwtPayload } from 'jsonwebtoken';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { SyncAgentConfig } from './config.js';
import type { EvaluatedLicenseState, LicenseValidationResult } from './types.js';

const OFFLINE_GRACE_DAYS = 30;
const OFFLINE_GRACE_MS = OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000;

const CONTROL_PLANE_KEY_FILE_CANDIDATES = [
  'control-plane-public.pem',
  'control_plane_public.pem',
  'control-plane.pub',
  'license-public.pem',
] as const;

const FREE_TIER_FEATURES = [
  'manual_claim_entry',
  'rule_engine',
  'basic_dashboard',
  'document_upload',
  'tesseract_ocr',
] as const;

interface DecodedLicenseToken extends JwtPayload {
  sub?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  tier?: 'FREE' | 'PRO';
  features?: unknown;
  facilityId?: string;
  tenantId?: string;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function uniqueStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const collected = new Set<string>();

  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }

    const normalized = item.trim();
    if (normalized.length > 0) {
      collected.add(normalized);
    }
  }

  return [...collected];
}

export function extractFacilityId(payload: DecodedLicenseToken): string {
  const facilityId = asNonEmptyString(payload.facilityId) ?? asNonEmptyString(payload.sub);

  if (!facilityId) {
    throw new Error('License token is missing facility identifier');
  }

  return facilityId;
}

export function evaluateLicenseState(input: {
  payload: DecodedLicenseToken;
  now: Date;
}): EvaluatedLicenseState {
  const { payload, now } = input;
  const exp = typeof payload.exp === 'number' ? payload.exp : null;

  if (exp === null) {
    throw new Error('License token is missing exp claim');
  }

  const expiresAt = new Date(exp * 1000);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error('License token has invalid exp claim');
  }

  const offlineGraceUntil = new Date(expiresAt.getTime() + OFFLINE_GRACE_MS);

  let status: EvaluatedLicenseState['status'];

  if (now.getTime() <= expiresAt.getTime()) {
    status = 'VALID';
  } else if (now.getTime() <= offlineGraceUntil.getTime()) {
    status = 'GRACE';
  } else {
    status = 'EXPIRED';
  }

  const tokenTier: 'FREE' | 'PRO' = payload.tier === 'PRO' ? 'PRO' : 'FREE';
  const tokenFeatures = uniqueStringList(payload.features);

  if (status === 'EXPIRED') {
    return {
      tier: 'FREE',
      features: [...FREE_TIER_FEATURES],
      expiresAt,
      offlineGraceUntil,
      status,
    };
  }

  return {
    tier: tokenTier,
    features: tokenTier === 'PRO' ? tokenFeatures : [...FREE_TIER_FEATURES],
    expiresAt,
    offlineGraceUntil,
    status,
  };
}

export class LicenseValidator {
  private cachedPublicKey: string | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly config: SyncAgentConfig,
    private readonly logger: Logger,
  ) {}

  async validateAndPersist(input: {
    token: string;
    expectedFacilityId: string;
    now?: Date;
  }): Promise<LicenseValidationResult> {
    const token = input.token.trim();
    if (token.length === 0) {
      throw new Error('License token is empty');
    }

    const publicKey = await this.resolvePublicKey();

    const decoded = verifyJwt(token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'claimflow-control-plane',
      ignoreExpiration: true,
    });

    if (typeof decoded === 'string') {
      throw new Error('License token payload is not an object');
    }

    const payload = decoded as DecodedLicenseToken;
    const facilityId = extractFacilityId(payload);

    if (facilityId !== input.expectedFacilityId) {
      throw new Error(
        `License token facility mismatch (expected ${input.expectedFacilityId}, got ${facilityId})`,
      );
    }

    const state = evaluateLicenseState({
      payload,
      now: input.now ?? new Date(),
    });

    await this.persistLicenseState({
      facilityId,
      state,
      token,
      sourceTier: payload.tier === 'PRO' ? 'PRO' : 'FREE',
      sourceFeatures: uniqueStringList(payload.features),
      tenantId: asNonEmptyString(payload.tenantId),
    });

    if (state.status !== 'VALID') {
      this.logger.warn(
        {
          facilityId,
          status: state.status,
          expiresAt: state.expiresAt.toISOString(),
          offlineGraceUntil: state.offlineGraceUntil.toISOString(),
        },
        'license token is not currently valid',
      );
    }

    return {
      facilityId,
      tier: state.tier,
      features: state.features,
      status: state.status,
      expiresAt: state.expiresAt.toISOString(),
      offlineGraceUntil: state.offlineGraceUntil.toISOString(),
      token,
    };
  }

  private async resolvePublicKey(): Promise<string> {
    if (this.cachedPublicKey) {
      return this.cachedPublicKey;
    }

    const inlineKey = this.config.CONTROL_PLANE_PUBLIC_KEY;
    if (inlineKey) {
      this.cachedPublicKey = inlineKey;
      return inlineKey;
    }

    for (const fileName of CONTROL_PLANE_KEY_FILE_CANDIDATES) {
      const candidate = path.join(this.config.KEY_PATH, fileName);

      try {
        const fileContent = await readFile(candidate, 'utf8');
        const trimmed = fileContent.trim();

        if (trimmed.length === 0) {
          continue;
        }

        this.cachedPublicKey = trimmed;
        return trimmed;
      } catch {
        continue;
      }
    }

    throw new Error(
      `Unable to locate control plane public key. Set CONTROL_PLANE_PUBLIC_KEY or place PEM in ${this.config.KEY_PATH}.`,
    );
  }

  private async persistLicenseState(input: {
    facilityId: string;
    state: EvaluatedLicenseState;
    token: string;
    sourceTier: 'FREE' | 'PRO';
    sourceFeatures: string[];
    tenantId: string | null;
  }): Promise<void> {
    const featureFlags = {
      features: input.state.features,
      sourceTier: input.sourceTier,
      sourceFeatures: input.sourceFeatures,
      status: input.state.status,
      tenantId: input.tenantId,
    };

    await this.pool.query(
      `INSERT INTO license_state (
          facility_id,
          tier,
          license_token,
          feature_flags,
          expires_at,
          last_validated_at,
          offline_grace_until
        ) VALUES (
          $1::uuid,
          $2,
          $3,
          $4::jsonb,
          $5::timestamptz,
          now(),
          $6::timestamptz
        )
        ON CONFLICT (facility_id)
        DO UPDATE SET
          tier = EXCLUDED.tier,
          license_token = EXCLUDED.license_token,
          feature_flags = EXCLUDED.feature_flags,
          expires_at = EXCLUDED.expires_at,
          last_validated_at = now(),
          offline_grace_until = EXCLUDED.offline_grace_until`,
      [
        input.facilityId,
        input.state.tier,
        input.token,
        JSON.stringify(featureFlags),
        input.state.expiresAt.toISOString(),
        input.state.offlineGraceUntil.toISOString(),
      ],
    );
  }
}
