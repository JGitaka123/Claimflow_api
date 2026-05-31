// ============================================================================
// PAYER TYPES — Multi-payer catalog (SHA + private insurers)
// ============================================================================
//
// ClaimFlow audits claims against a *payer-specific* rulepack. The payer catalog
// is global reference data (like ICD codes), not tenant-scoped: every hospital
// audits against the same SHA / AAR / Jubilee / CIC rules. A claim references a
// payer; the audit pipeline resolves that payer's active rulepack version.

export enum PayerStatus {
  /** Rulepack authored and available — claims can be audited against this payer. */
  ACTIVE = 'ACTIVE',
  /** Listed in the catalog (so the UI can show it) but no rulepack yet. */
  COMING_SOON = 'COMING_SOON',
  /** Hidden / disabled — not selectable. */
  INACTIVE = 'INACTIVE',
}

export interface Payer {
  id: string;
  /** Stable lookup key used in URLs and rulepack directory names, e.g. 'sha'. */
  slug: string;
  /** Display name, e.g. 'Social Health Authority'. */
  name: string;
  /** Short label for compact UI (badges, dropdowns), e.g. 'SHA'. */
  shortName: string | null;
  status: PayerStatus;
  /** Active rulepack version for this payer (semver), or null when none exists yet. */
  rulepackVersion: string | null;
  /** ISO 3166-1 alpha-2 country code; 'KE' for the Kenyan launch market. */
  countryCode: string;
  /** Ascending display order in catalog listings. */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
