import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Rulepack } from '@claimflow/shared';

const loadRulepackMock = vi.fn();
const evaluateRulepackMock = vi.fn();

vi.mock('../src/loader.js', () => ({
  loadRulepack: (...args: unknown[]) => loadRulepackMock(...args),
}));

vi.mock('../src/evaluator.js', () => ({
  evaluate: (...args: unknown[]) => evaluateRulepackMock(...args),
}));

import { createRuleEngine } from '../src/engine.js';
import { createRuleInput } from './helpers/test-data.js';

function makeRulepack(version: string): Rulepack {
  return {
    manifest: {
      version,
      sha_policy_version: 'LN-56-2025',
      description: 'mock',
      rule_count: 0,
      checksum: '',
    },
    rules: [],
    rulesByCategory: new Map(),
    ruleById: new Map(),
  };
}

describe('engine coverage branches', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reuses in-flight rulepack load for concurrent evaluate calls', async () => {
    let resolver: ((value: Rulepack) => void) | null = null;
    const deferred = new Promise<Rulepack>((resolve) => {
      resolver = resolve;
    });

    loadRulepackMock.mockReturnValueOnce(deferred);
    evaluateRulepackMock.mockReturnValue({ decision: 'PASSED' });

    const engine = createRuleEngine('unused-dir', '1.0.0');
    const input = createRuleInput();

    const first = engine.evaluate(input, 'en');
    const second = engine.evaluate(input, 'sw');

    expect(loadRulepackMock).toHaveBeenCalledTimes(1);

    resolver?.(makeRulepack('1.0.0'));
    await Promise.all([first, second]);

    expect(evaluateRulepackMock).toHaveBeenCalledTimes(2);
  });

  it('updates activeVersion when reload is called with a new version', async () => {
    loadRulepackMock.mockResolvedValueOnce(makeRulepack('2.0.0'));

    const engine = createRuleEngine('unused-dir', '1.0.0');

    await engine.reload('2.0.0');

    expect(engine.activeVersion).toBe('2.0.0');
    expect(loadRulepackMock).toHaveBeenLastCalledWith('unused-dir', '2.0.0', undefined);
  });
});

