import { RuleCategory } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { loadRulepack } from '../src/loader.js';
import { createTempRulepackFixture } from './helpers/rulepack-fixture.js';

describe('loadRulepack', () => {
  it('loads a valid rulepack with indexed rules', async () => {
    const fixture = await createTempRulepackFixture();

    try {
      const loaded = await loadRulepack(fixture.rootDir, fixture.version);

      expect(loaded.manifest.version).toBe('1.0.0');
      expect(loaded.rules).toHaveLength(1);
      expect(loaded.ruleById.has('IDN-001')).toBe(true);
      expect(loaded.rulesByCategory.get(RuleCategory.IDENTITY) ?? []).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('throws when a rule is missing required fields', async () => {
    const fixture = await createTempRulepackFixture({
      categoryFiles: {
        'identity.yaml': [
          'rules:',
          '  - rule_id: "IDN-001"',
          '    category: IDENTITY',
          '    severity: HARD_STOP',
          '    applies_to: ["ALL"]',
          '    params: {}',
          '    message_i18n:',
          '      en: "Patient SHA ID must exist"',
          '    remediation_i18n:',
          '      en: "Verify the SHA ID"',
          '',
        ].join('\n'),
      },
    });

    try {
      await expect(loadRulepack(fixture.rootDir, fixture.version)).rejects.toThrow(/logic_key/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it('throws when manifest version does not match requested version', async () => {
    const fixture = await createTempRulepackFixture({
      manifestYaml: [
        'version: "9.9.9"',
        'sha_policy_version: "LN-56-2025"',
        'description: "Bad manifest"',
        'rule_count: 1',
        '',
      ].join('\n'),
    });

    try {
      await expect(loadRulepack(fixture.rootDir, fixture.version)).rejects.toThrow(/version mismatch/i);
    } finally {
      await fixture.cleanup();
    }
  });
});
