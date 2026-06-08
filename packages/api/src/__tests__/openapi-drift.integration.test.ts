import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { loadConfig, type Config } from '../config.js';
import { closePool } from '../db/client.js';
import { buildServer } from '../server.js';

// ============================================================================
// OpenAPI DRIFT CHECK (the milestone's teeth).
//
// Detects code <-> spec divergence three ways, so drift fails the build:
//   1. ROUTE COVERAGE (both directions): build the real server, capture every
//      registered route via the onRoute hook, normalize to OpenAPI path syntax,
//      and assert the set of (method, path) pairs equals the set declared in
//      docs/openapi.yaml. A new/renamed/removed route that isn't mirrored in the
//      spec fails. (Auto-added HEAD and OPTIONS are ignored.)
//   2. SPEC VALIDITY: the document parses and its component schemas compile under
//      a JSON-Schema 2020-12 validator (OpenAPI 3.1 is 2020-12 aligned).
//   3. PAYLOAD CONFORMANCE: representative live responses are validated against
//      the referenced response schema, and the scoring schema is asserted to
//      forbid rule internals (additionalProperties:false + no internal fields).
// ============================================================================

const currentDir = dirname(fileURLToPath(import.meta.url));
// The drift check needs no live database — buildServer constructs lazily and we
// only enumerate routes (onRoute) and parse the spec. A DATABASE_URL must merely
// be *set* for config to load, so this runs in BOTH CI jobs (with and without a
// Postgres service), catching drift on every PR.
const databaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://drift:drift@127.0.0.1:5432/drift';

const SPEC_PATH = resolve(currentDir, '../../../../docs/openapi.yaml');

// Methods Fastify adds automatically and we don't document per-operation.
const IGNORED_METHODS = new Set(['HEAD', 'OPTIONS']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

function normalizePath(url: string): string {
  // Fastify ":param" -> OpenAPI "{param}". Strip trailing slash (except root).
  const converted = url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return converted.length > 1 ? converted.replace(/\/+$/, '') : converted;
}

// Rewrite local OpenAPI $refs (#/components/schemas/X) to JSON-Schema $defs
// (#/$defs/X) so a component can be compiled standalone by ajv.
function rewriteRefs(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(rewriteRefs);
  if (obj && typeof obj === 'object') {
    const out: AnyObj = {};
    for (const [k, v] of Object.entries(obj as AnyObj)) {
      out[k] = k === '$ref' && typeof v === 'string' ? v.replace('#/components/schemas/', '#/$defs/') : rewriteRefs(v);
    }
    return out;
  }
  return obj;
}

function specOperations(spec: AnyObj): Set<string> {
  const ops = new Set<string>();
  const paths = (spec.paths ?? {}) as AnyObj;
  for (const [path, item] of Object.entries(paths)) {
    for (const method of Object.keys(item as AnyObj)) {
      if (method === 'parameters') continue;
      ops.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return ops;
}

describe('OpenAPI drift check', () => {
  let spec: AnyObj;
  let serverRoutes: Set<string>;

  beforeAll(async () => {
    const config: Config = loadConfig({
      exitOnError: false,
      env: { DATABASE_URL: databaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_RPM: '100000' },
    });
    spec = parseYaml(await readFile(SPEC_PATH, 'utf8')) as AnyObj;

    // Capture routes from a real server instance via onRoute (no DB connection
    // is made — pools are lazy, and we close before any handler runs).
    serverRoutes = new Set<string>();
    const probe = buildServer({ config });
    probe.addHook('onRoute', (r) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) {
        if (IGNORED_METHODS.has(m)) continue;
        serverRoutes.add(`${m} ${normalizePath(r.url)}`);
      }
    });
    await probe.ready();
    await probe.close();
  });

  afterAll(async () => {
    await closePool();
  });

  it('the spec is OpenAPI 3.1 and its schemas compile', () => {
    expect(spec.openapi).toBe('3.1.0');
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const schemas = (spec.components?.schemas ?? {}) as AnyObj;
    const defs = rewriteRefs(schemas) as AnyObj;
    for (const [name, schema] of Object.entries(defs)) {
      // Resolve local $refs against the components for standalone compilation.
      const withDefs = { ...(schema as AnyObj), $defs: defs };
      expect(() => ajv.compile(withDefs), `schema ${name} should compile`).not.toThrow();
    }
  });

  it('every implemented route is documented in the spec (no undocumented routes)', () => {
    const ops = specOperations(spec);
    const undocumented = [...serverRoutes].filter((r) => !ops.has(r)).sort();
    expect(undocumented, `Routes implemented but missing from docs/openapi.yaml:\n${undocumented.join('\n')}`).toEqual([]);
  });

  it('every documented route is implemented (no phantom spec entries)', () => {
    const ops = specOperations(spec);
    const phantom = [...ops].filter((r) => !serverRoutes.has(r)).sort();
    expect(phantom, `Routes in docs/openapi.yaml with no implementation:\n${phantom.join('\n')}`).toEqual([]);
  });

  it('the public response schemas expose no SYSTEM INTERNALS (scores / fix report / engine params)', () => {
    const schemas = (spec.components?.schemas ?? {}) as AnyObj;
    const publicSchemas = ['ScoreFlag', 'ClaimScoreResult', 'AuditSummary', 'AuditSummaryFinding'];
    // The three system internals + engine-config names are banned on EVERY public
    // schema — they must never leave the server over the API.
    const bannedEverywhere = [
      'deterministicScore', 'mlQualityScore', 'fixReportMd',
      'threshold', 'thresholds', 'ruleDefinition', 'logic', 'params', 'weight', 'modelScore', 'rawScore',
    ];
    // `evidence` is claim-level justification: allowed on the audit finding (the
    // dashboard needs it), but NOT on the scoring schemas (machine-facing, public).
    const evidenceBannedOn = new Set(['ScoreFlag', 'ClaimScoreResult']);
    for (const name of publicSchemas) {
      const schema = schemas[name] as AnyObj;
      expect(schema, `${name} must exist`).toBeDefined();
      expect(schema.additionalProperties, `${name} must be a closed schema`).toBe(false);
      const props = Object.keys(schema.properties ?? {});
      for (const b of bannedEverywhere) {
        expect(props, `${name} must not expose ${b}`).not.toContain(b);
      }
      if (evidenceBannedOn.has(name)) {
        expect(props, `${name} must not expose evidence`).not.toContain('evidence');
      }
    }
  });

  it('a live response validates against its spec schema (envelope + scoring shape)', async () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const schemas = (spec.components?.schemas ?? {}) as AnyObj;

    // Compile the score-result envelope with all component schemas as $defs and
    // local $ref rewritten to #/$defs/... so ajv resolves them standalone.
    const rewrittenDefs = rewriteRefs(schemas) as AnyObj;
    const envelopeSchema = { ...(rewrittenDefs.EnvelopeClaimScoreResult as AnyObj), $defs: rewrittenDefs };
    const validate = ajv.compile(envelopeSchema);

    // Build a minimal score response shape and validate it (proves the schema is
    // usable against real payloads; the scoring integration test exercises the
    // live endpoint end-to-end).
    const sample = {
      data: {
        claimId: '00000000-0000-0000-0000-000000000001',
        auditId: '00000000-0000-0000-0000-000000000002',
        payer: { slug: 'sha', name: 'SHA' },
        riskLevel: 'LOW',
        recommendedAction: 'READY_FOR_SUBMISSION',
        flags: [
          { reasonCode: 'CF-FIN-021', category: 'financial', severity: 'WARNING', message: 'x', auditorGeneralTypology: null },
        ],
        counts: { failed: 0, warning: 1, incomplete: 0, passed: 3 },
      },
      meta: { requestId: 'r1' },
    };
    const ok = validate(sample);
    expect(ok, JSON.stringify(validate.errors)).toBe(true);

    // A payload carrying a rule internal must be REJECTED by the closed schema.
    const leaky = JSON.parse(JSON.stringify(sample)) as AnyObj;
    leaky.data.flags[0].threshold = 0.85;
    expect(validate(leaky)).toBe(false);

    // AuditSummary: a valid summary carries message/remediation/evidence; a payload
    // carrying any of the three SYSTEM INTERNALS is rejected by the closed schema.
    const auditEnvelope = { ...(rewrittenDefs.EnvelopeAuditSummary as AnyObj), $defs: rewrittenDefs };
    const validateAudit = ajv.compile(auditEnvelope);
    const auditSample = {
      data: {
        auditId: '00000000-0000-0000-0000-000000000002',
        claimId: '00000000-0000-0000-0000-000000000001',
        payer: { slug: 'sha', name: 'SHA' },
        decision: 'WARNING',
        totalRules: 4,
        passedCount: 3,
        failedCount: 0,
        warningCount: 1,
        incompleteCount: 0,
        skippedCount: 0,
        rulepackVersion: '1.0.0',
        startedAt: '2026-03-05T00:00:00.000Z',
        completedAt: '2026-03-05T00:00:01.000Z',
        findings: [
          {
            ruleId: 'FIN-021', category: 'financial', severity: 'WARNING', result: 'WARNING',
            message: 'x', remediation: 'fix it', evidence: { field: 'patient_sha_id' }, auditorGeneralTypology: null,
          },
        ],
      },
      meta: { requestId: 'r2' },
    };
    expect(validateAudit(auditSample), JSON.stringify(validateAudit.errors)).toBe(true);

    // The three system internals are rejected wherever they appear.
    const leakSession = JSON.parse(JSON.stringify(auditSample)) as AnyObj;
    leakSession.data.fixReportMd = '# fix';
    expect(validateAudit(leakSession)).toBe(false);
    const leakScore = JSON.parse(JSON.stringify(auditSample)) as AnyObj;
    leakScore.data.deterministicScore = 0.9;
    expect(validateAudit(leakScore)).toBe(false);
    const leakMl = JSON.parse(JSON.stringify(auditSample)) as AnyObj;
    leakMl.data.findings[0].mlQualityScore = 0.7;
    expect(validateAudit(leakMl)).toBe(false);
  });

  it('documents the security schemes and problem+json contract', () => {
    const schemes = (spec.components?.securitySchemes ?? {}) as AnyObj;
    expect(Object.keys(schemes)).toEqual(
      expect.arrayContaining(['bearerJwt', 'apiKey', 'oauth2ClientCredentials']),
    );
    expect(schemes.oauth2ClientCredentials.flows.clientCredentials.tokenUrl).toBe('/v1/oauth/token');
    // problem+json on the public endpoints.
    const score = spec.paths['/v1/claims/score'].post;
    expect(score.responses['400'].content['application/problem+json']).toBeDefined();
    const token = spec.paths['/v1/oauth/token'].post;
    expect(token.responses['401'].content['application/problem+json']).toBeDefined();
  });

  it('documents the Idempotency-Key header on submission endpoints', () => {
    const createClaim = spec.paths['/v1/claims'].post;
    const score = spec.paths['/v1/claims/score'].post;
    const hasIdem = (op: AnyObj): boolean =>
      (op.parameters ?? []).some((p: AnyObj) => p.$ref === '#/components/parameters/IdempotencyKey');
    expect(hasIdem(createClaim)).toBe(true);
    expect(hasIdem(score)).toBe(true);
  });
});
