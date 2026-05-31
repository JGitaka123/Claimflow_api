import { DomainError, ErrorCode } from '@claimflow/shared';
import { createRuleEngine, type RuleEngine } from '@claimflow/rule-engine';

/**
 * Per-payer rule engine registry. The audit pipeline evaluates each claim against
 * *its own payer's* rulepack, so we keep one `RuleEngine` per payer slug — created
 * lazily on first use and cached for the lifetime of the process. Each engine
 * internally caches its loaded rulepack, so a rulepack is read from disk at most
 * once per payer.
 *
 * Adjudication integrity: a payer with no authoritative rulepack version is never
 * adjudicated — `getEngineForPayer` fails closed rather than returning a fallback.
 */

/** Slug of the default payer, which uses the legacy flat rulepack layout. */
export const DEFAULT_PAYER_SLUG = 'sha';

export interface PayerEngineKey {
  slug: string;
  rulepackVersion: string | null;
}

export type RuleEngineFactory = (
  rulepackDir: string,
  version: string,
  payerSlug?: string,
) => RuleEngine;

export interface RuleEngineRegistryOptions {
  rulepackDir: string;
  /** Pre-built engine to use for the default (SHA) payer — primarily for tests. */
  defaultEngine?: RuleEngine;
  /** Override engine construction (tests); defaults to `createRuleEngine`. */
  createEngine?: RuleEngineFactory;
}

export interface RuleEngineRegistry {
  getEngineForPayer: (payer: PayerEngineKey) => RuleEngine;
}

export function createRuleEngineRegistry(options: RuleEngineRegistryOptions): RuleEngineRegistry {
  const createEngine = options.createEngine ?? createRuleEngine;
  const engines = new Map<string, RuleEngine>();

  return {
    getEngineForPayer(payer: PayerEngineKey): RuleEngine {
      const { slug, rulepackVersion } = payer;

      if (!rulepackVersion) {
        throw new DomainError(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Payer '${slug}' has no active rulepack; claims for this payer cannot be audited`,
        );
      }

      const cached = engines.get(slug);
      if (cached) {
        return cached;
      }

      let engine: RuleEngine;
      if (slug === DEFAULT_PAYER_SLUG && options.defaultEngine) {
        engine = options.defaultEngine;
      } else if (slug === DEFAULT_PAYER_SLUG) {
        // SHA uses the legacy flat rulepack layout: <dir>/<version>/
        engine = createEngine(options.rulepackDir, rulepackVersion);
      } else {
        // Other payers use the namespaced layout: <dir>/<slug>/<version>/
        engine = createEngine(options.rulepackDir, rulepackVersion, slug);
      }

      engines.set(slug, engine);
      return engine;
    },
  };
}
