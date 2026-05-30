// ============================================================================
// SHA TARIFF LOOKUP — Section 9 (tariffs table) + FIN rules
// ============================================================================

export interface Tariff {
  id: string;
  tariffVersionId: string;
  shaServiceCode: string;
  description: string;
  benefitPackage: string;
  facilityTier: string | null;
  claimType: string | null;
  maxAmountKes: number;
  requiresPreauth: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface TariffLookup {
  findByServiceCode(code: string, benefitPackage: string, facilityTier: string): Tariff | null;
  isValidServiceCode(code: string): boolean;
  getMaxAmount(code: string, benefitPackage: string, facilityTier: string): number | null;
  requiresPreauth(code: string): boolean;
}

/**
 * Creates a tariff lookup from an array of tariffs.
 * In production, loaded from the database.
 */
export function createTariffLookup(tariffs: Tariff[]): TariffLookup {
  const codeIndex = new Map<string, Tariff[]>();
  for (const t of tariffs) {
    const key = t.shaServiceCode.toUpperCase();
    const existing = codeIndex.get(key) ?? [];
    existing.push(t);
    codeIndex.set(key, existing);
  }

  return {
    findByServiceCode(code: string, benefitPackage: string, facilityTier: string): Tariff | null {
      const entries = codeIndex.get(code.toUpperCase());
      if (!entries) return null;
      // Find best match: exact tier > null tier
      return entries.find(t =>
        t.benefitPackage === benefitPackage &&
        (t.facilityTier === facilityTier || t.facilityTier === null)
      ) ?? null;
    },

    isValidServiceCode(code: string): boolean {
      return codeIndex.has(code.toUpperCase());
    },

    getMaxAmount(code: string, benefitPackage: string, facilityTier: string): number | null {
      const tariff = this.findByServiceCode(code, benefitPackage, facilityTier);
      return tariff?.maxAmountKes ?? null;
    },

    requiresPreauth(code: string): boolean {
      const entries = codeIndex.get(code.toUpperCase());
      return entries?.some(t => t.requiresPreauth) ?? false;
    },
  };
}
