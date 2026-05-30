// ============================================================================
// ICD-11 CODE LOADER — Section 12 (for CLN-001, CLN-002 rules)
// In production, this loads from the icd_codes database table.
// This module provides the interface and a local cache for rule engine use.
// ============================================================================

export interface IcdCode {
  code: string;
  version: string;
  titleEn: string;
  titleSw: string | null;
  chapter: string | null;
  block: string | null;
  isLeaf: boolean;
}

export interface IcdCodeLookup {
  isValidCode(code: string): boolean;
  isLeafCode(code: string): boolean;
  getCode(code: string): IcdCode | null;
}

/**
 * Creates an ICD code lookup from an array of codes.
 * In production, the array is loaded from the database at startup.
 */
export function createIcdLookup(codes: IcdCode[]): IcdCodeLookup {
  const codeMap = new Map(codes.map(c => [c.code.toUpperCase(), c]));

  return {
    isValidCode(code: string): boolean {
      return codeMap.has(code.toUpperCase());
    },
    isLeafCode(code: string): boolean {
      const entry = codeMap.get(code.toUpperCase());
      return entry?.isLeaf ?? false;
    },
    getCode(code: string): IcdCode | null {
      return codeMap.get(code.toUpperCase()) ?? null;
    },
  };
}
