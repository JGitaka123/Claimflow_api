export type GovernanceMode = 'METRICS_ONLY' | 'DEIDENTIFIED' | 'FULL_ANALYTICS';

export interface FacilityContext {
  facilityId: string;
  tenantId: string;
  facilityName: string;
  shaFacilityCode: string;
}

export interface MetricsPayload {
  facilityId: string;
  period: {
    from: string;
    to: string;
  };
  claims: {
    created: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  };
  audit: {
    total: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
  };
  ruleFailures: Array<{
    ruleId: string;
    count: number;
  }>;
  ml: {
    avgOcrConfidence: number;
    documentsProcessed: number;
    manualEntryRequired: number;
    errors: number;
  };
  system: {
    uptime: number;
    diskUsagePercent: number | null;
    rupackVersion: string;
    rulepackVersion: string;
  };
  deidentifiedSnapshots?: Array<{
    claimHash: string;
    claimType: string;
    visitType: string;
    amountTotal: number;
    dayShifted: string;
  }>;
  analyticsSummary?: {
    topServiceCodes: Array<{ code: string; count: number; totalAmount: number }>;
  };
}

export interface HeartbeatRequest {
  facilityId: string;
  softwareVersion: string;
  activeRulepackVersion: string;
  governanceMode: GovernanceMode;
  metrics?: MetricsPayload;
}

export interface HeartbeatResponse {
  data: {
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
  };
}

export interface RulepackDownloadInput {
  controlPlaneUrl: string;
  downloadUrl: string;
  checksum: string;
  version: string;
  licenseToken: string;
}

export interface RulepackSyncResult {
  version: string;
  checksum: string;
  storedPath: string;
  inserted: boolean;
}

export interface EvaluatedLicenseState {
  tier: 'FREE' | 'PRO';
  features: string[];
  expiresAt: Date;
  offlineGraceUntil: Date;
  status: 'VALID' | 'GRACE' | 'EXPIRED';
}

export interface LicenseValidationResult {
  facilityId: string;
  tier: 'FREE' | 'PRO';
  features: string[];
  status: 'VALID' | 'GRACE' | 'EXPIRED';
  expiresAt: string;
  offlineGraceUntil: string;
  token: string;
}
