import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Repo root, from packages/sdk-node/src/__tests__/.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const TS_TYPES = resolve(repoRoot, 'packages/sdk-node/src/generated/types.ts');
const PY_MODELS = resolve(repoRoot, 'sdks/python/claimflow/models.py');

// The three SYSTEM INTERNALS that must NEVER reach an API consumer, in both the
// camelCase (TS / JSON) and snake_case (pydantic) spellings.
const INTERNAL_TOKENS = [
  'deterministicScore',
  'mlQualityScore',
  'fixReportMd',
  'deterministic_score',
  'ml_quality_score',
  'fix_report_md',
];

/**
 * Match a token only where it is an actual property/field *declaration*
 * (`token:` or `token?:`), not a substring inside a doc-comment that mentions
 * the internals to reassure they are never returned.
 */
function declaresProperty(source: string, token: string): boolean {
  return new RegExp(`\\b${token}\\b\\s*\\??\\s*:`).test(source);
}

describe('SDK artifacts never expose detection internals', () => {
  const ts = readFileSync(TS_TYPES, 'utf8');
  const py = readFileSync(PY_MODELS, 'utf8');

  it('the TS types declare none of the three system internals as fields', () => {
    for (const token of INTERNAL_TOKENS) {
      expect(declaresProperty(ts, token), `TS types must not declare ${token}`).toBe(false);
    }
  });

  it('the Python models declare none of the three system internals as fields', () => {
    for (const token of INTERNAL_TOKENS) {
      expect(declaresProperty(py, token), `Python models must not declare ${token}`).toBe(false);
    }
  });

  it('neither artifact references an /internal path or an *Internal operation', () => {
    for (const [label, source] of [
      ['TS', ts],
      ['Python', py],
    ] as const) {
      expect(source.includes('/internal'), `${label}: no /internal path`).toBe(false);
      expect(/\bInternal\b/.test(source), `${label}: no *Internal operation/type`).toBe(false);
    }
  });

  it('the closed public scoring/audit types ARE present (proves the SDK still covers them)', () => {
    expect(ts).toContain('ClaimScoreResult');
    expect(ts).toContain('AuditSummary');
    expect(py).toContain('ClaimScoreResult');
    expect(py).toContain('AuditSummary');
  });
});
