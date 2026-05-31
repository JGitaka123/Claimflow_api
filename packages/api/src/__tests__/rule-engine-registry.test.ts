import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@claimflow/shared';
import type { RuleEngine } from '@claimflow/rule-engine';
import {
  createRuleEngineRegistry,
  DEFAULT_PAYER_SLUG,
} from '../workflows/rule-engine-registry.js';

function fakeEngine(version: string, payerSlug: string | null = null): RuleEngine {
  return {
    evaluate: vi.fn(),
    reload: vi.fn(),
    activeVersion: version,
    payerSlug,
  };
}

describe('createRuleEngineRegistry', () => {
  it('uses the injected default engine for the SHA payer without constructing one', () => {
    const defaultEngine = fakeEngine('1.0.0');
    const createEngine = vi.fn(fakeEngine);
    const registry = createRuleEngineRegistry({
      rulepackDir: '/rp',
      defaultEngine,
      createEngine,
    });

    const engine = registry.getEngineForPayer({ slug: DEFAULT_PAYER_SLUG, rulepackVersion: '1.0.0' });

    expect(engine).toBe(defaultEngine);
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('constructs the SHA engine with the flat layout (no payer slug)', () => {
    const createEngine = vi.fn(fakeEngine);
    const registry = createRuleEngineRegistry({ rulepackDir: '/rp', createEngine });

    registry.getEngineForPayer({ slug: 'sha', rulepackVersion: '1.0.0' });

    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(createEngine).toHaveBeenCalledWith('/rp', '1.0.0');
  });

  it('constructs non-SHA engines with the payer-namespaced layout', () => {
    const createEngine = vi.fn(fakeEngine);
    const registry = createRuleEngineRegistry({ rulepackDir: '/rp', createEngine });

    registry.getEngineForPayer({ slug: 'aar', rulepackVersion: '2.1.0' });

    expect(createEngine).toHaveBeenCalledWith('/rp', '2.1.0', 'aar');
  });

  it('caches one engine per payer slug', () => {
    const createEngine = vi.fn(fakeEngine);
    const registry = createRuleEngineRegistry({ rulepackDir: '/rp', createEngine });

    const first = registry.getEngineForPayer({ slug: 'aar', rulepackVersion: '1.0.0' });
    const second = registry.getEngineForPayer({ slug: 'aar', rulepackVersion: '1.0.0' });

    expect(first).toBe(second);
    expect(createEngine).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a payer has no rulepack version', () => {
    const createEngine = vi.fn(fakeEngine);
    const registry = createRuleEngineRegistry({ rulepackDir: '/rp', createEngine });

    expect(() => registry.getEngineForPayer({ slug: 'jubilee', rulepackVersion: null })).toThrow(
      DomainError,
    );
    expect(createEngine).not.toHaveBeenCalled();
  });
});
