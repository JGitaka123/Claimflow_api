import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TempRulepackFixture {
  rootDir: string;
  versionDir: string;
  version: string;
  cleanup: () => Promise<void>;
}

interface FixtureOptions {
  version?: string;
  manifestYaml?: string;
  categoryFiles?: Partial<Record<CategoryFileName, string>>;
  /** When set, the rulepack is written under <root>/<payerSlug>/<version>/. */
  payerSlug?: string;
}

type CategoryFileName =
  | 'identity.yaml'
  | 'documentation.yaml'
  | 'clinical.yaml'
  | 'authorization.yaml'
  | 'financial.yaml'
  | 'structural.yaml';

const DEFAULT_MANIFEST = [
  'version: "1.0.0"',
  'sha_policy_version: "LN-56-2025"',
  'description: "Test fixture rulepack"',
  'rule_count: 1',
  '',
].join('\n');

const DEFAULT_IDENTITY = [
  'rules:',
  '  - rule_id: "IDN-001"',
  '    category: IDENTITY',
  '    severity: HARD_STOP',
  '    logic_key: "placeholder_rule_logic"',
  '    applies_to: ["ALL"]',
  '    params: {}',
  '    message_i18n:',
  '      en: "Patient SHA ID must exist"',
  '      sw: "Nambari ya SHA lazima ipatikane"',
  '    remediation_i18n:',
  '      en: "Verify the SHA ID"',
  '      sw: "Thibitisha nambari ya SHA"',
  '    is_active: true',
  '    sort_order: 1',
  '',
].join('\n');

const EMPTY_CATEGORY_FILE = 'rules: []\n';

export async function createTempRulepackFixture(options: FixtureOptions = {}): Promise<TempRulepackFixture> {
  const version = options.version ?? '1.0.0';
  const rootDir = await mkdtemp(path.join(tmpdir(), 'claimflow-rulepack-'));
  const baseDir = options.payerSlug ? path.join(rootDir, options.payerSlug) : rootDir;
  const versionDir = path.join(baseDir, version);

  await mkdir(versionDir, { recursive: true });
  await writeFile(path.join(versionDir, 'manifest.yaml'), options.manifestYaml ?? DEFAULT_MANIFEST, 'utf8');

  const categoryFiles: Record<CategoryFileName, string> = {
    'identity.yaml': DEFAULT_IDENTITY,
    'documentation.yaml': EMPTY_CATEGORY_FILE,
    'clinical.yaml': EMPTY_CATEGORY_FILE,
    'authorization.yaml': EMPTY_CATEGORY_FILE,
    'financial.yaml': EMPTY_CATEGORY_FILE,
    'structural.yaml': EMPTY_CATEGORY_FILE,
    ...options.categoryFiles,
  };

  for (const [fileName, content] of Object.entries(categoryFiles)) {
    await writeFile(path.join(versionDir, fileName), content, 'utf8');
  }

  return {
    rootDir,
    versionDir,
    version,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

