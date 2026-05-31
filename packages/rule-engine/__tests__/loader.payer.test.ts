import { describe, expect, it } from 'vitest';
import { loadRulepack } from '../src/loader.js';
import { createTempRulepackFixture } from './helpers/rulepack-fixture.js';

describe('loadRulepack payer namespacing', () => {
  it('loads a rulepack from a payer-namespaced directory', async () => {
    const fixture = await createTempRulepackFixture({ payerSlug: 'aar' });

    try {
      const loaded = await loadRulepack(fixture.rootDir, fixture.version, 'aar');

      expect(loaded.manifest.version).toBe('1.0.0');
      expect(loaded.ruleById.has('IDN-001')).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not fall back to the flat layout for a named payer', async () => {
    // Flat layout fixture (no payer subdir) but loaded *with* a payer slug:
    // resolution must fail rather than silently use the flat (SHA) rulepack.
    const fixture = await createTempRulepackFixture();

    try {
      await expect(loadRulepack(fixture.rootDir, fixture.version, 'aar')).rejects.toThrow(
        /Unable to load rulepack/i,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('still loads the flat layout when no payer slug is given', async () => {
    const fixture = await createTempRulepackFixture();

    try {
      const loaded = await loadRulepack(fixture.rootDir, fixture.version);

      expect(loaded.manifest.version).toBe('1.0.0');
      expect(loaded.ruleById.has('IDN-001')).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
