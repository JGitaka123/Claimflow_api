import { describe, expect, it } from 'vitest';
import { createRuleEngine } from '../src/engine.js';
import { createRuleInput } from './helpers/test-data.js';
import { createTempRulepackFixture } from './helpers/rulepack-fixture.js';

describe('createRuleEngine', () => {
  it('loads, evaluates, and reloads rulepacks', async () => {
    const fixture = await createTempRulepackFixture();

    try {
      const engine = createRuleEngine(fixture.rootDir, fixture.version);

      expect(engine.activeVersion).toBe('1.0.0');

      const output = await engine.evaluate(createRuleInput(), 'en');
      expect(output.totalRules).toBe(1);
      expect(output.decision).toBe('PASSED');

      await engine.reload();
      const outputAfterReload = await engine.evaluate(createRuleInput(), 'en');
      expect(outputAfterReload.totalRules).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });
});
