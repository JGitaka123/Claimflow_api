import type { Rulepack } from '@claimflow/shared';
import { evaluate as evaluateRulepack } from './evaluator.js';
import { loadRulepack } from './loader.js';
import type { RuleEngineInput, RuleEngineOutput } from './types.js';

export interface RuleEngine {
  evaluate: (input: RuleEngineInput, locale?: string) => Promise<RuleEngineOutput>;
  reload: (version?: string) => Promise<void>;
  readonly activeVersion: string;
  /** Payer this engine is bound to, or null for the legacy/default (SHA) layout. */
  readonly payerSlug: string | null;
}

export function createRuleEngine(
  rulepackDir: string,
  initialVersion = '1.0.0',
  payerSlug?: string,
): RuleEngine {
  let currentVersion = initialVersion;
  let cachedRulepack: Rulepack | null = null;
  let inFlightLoad: Promise<Rulepack> | null = null;

  const ensureLoaded = async (): Promise<Rulepack> => {
    if (cachedRulepack) {
      return cachedRulepack;
    }

    if (inFlightLoad) {
      return inFlightLoad;
    }

    inFlightLoad = loadRulepack(rulepackDir, currentVersion, payerSlug)
      .then((loadedRulepack) => {
        cachedRulepack = loadedRulepack;
        return loadedRulepack;
      })
      .finally(() => {
        inFlightLoad = null;
      });

    return inFlightLoad;
  };

  return {
    async evaluate(input: RuleEngineInput, locale = 'en'): Promise<RuleEngineOutput> {
      const loadedRulepack = await ensureLoaded();
      return evaluateRulepack(input, loadedRulepack, locale);
    },

    async reload(version?: string): Promise<void> {
      if (version) {
        currentVersion = version;
      }

      cachedRulepack = await loadRulepack(rulepackDir, currentVersion, payerSlug);
    },

    get activeVersion(): string {
      return currentVersion;
    },

    get payerSlug(): string | null {
      return payerSlug ?? null;
    },
  };
}
