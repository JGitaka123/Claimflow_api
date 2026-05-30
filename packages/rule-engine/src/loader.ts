import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import {
  RuleCategory,
  RuleSeverity,
  type Rulepack,
  type RulepackManifest,
  type RulepackRule,
} from '@claimflow/shared';

const CATEGORY_FILES: ReadonlyArray<{ category: RuleCategory; fileName: string }> = [
  { category: RuleCategory.IDENTITY, fileName: 'identity.yaml' },
  { category: RuleCategory.DOCUMENTATION, fileName: 'documentation.yaml' },
  { category: RuleCategory.CLINICAL, fileName: 'clinical.yaml' },
  { category: RuleCategory.AUTHORIZATION, fileName: 'authorization.yaml' },
  { category: RuleCategory.FINANCIAL, fileName: 'financial.yaml' },
  { category: RuleCategory.STRUCTURAL, fileName: 'structural.yaml' },
] as const;

interface ParsedManifest extends Omit<RulepackManifest, 'checksum'> {
  checksum?: string;
}

export async function loadRulepack(dir: string, version: string): Promise<Rulepack> {
  const candidates = buildVersionCandidates(version);

  let versionDir: string | null = null;
  let manifest: ParsedManifest | null = null;
  let lastError: unknown;

  for (const candidate of candidates) {
    const candidateDir = path.join(dir, candidate);
    const candidateManifestPath = path.join(candidateDir, 'manifest.yaml');

    try {
      const parsedManifest = validateManifest(await readYaml(candidateManifestPath), version, candidateManifestPath);
      versionDir = candidateDir;
      manifest = parsedManifest;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const missingManifest = message.includes('ENOENT') || message.includes('no such file or directory');

      if (missingManifest) {
        lastError = error;
        continue;
      }

      throw error;
    }
  }

  if (!versionDir || !manifest) {
    const message = lastError instanceof Error ? lastError.message : 'unknown error';
    throw new Error(`Unable to load rulepack version ${version}: ${message}`);
  }

  const rules: RulepackRule[] = [];

  for (const { category, fileName } of CATEGORY_FILES) {
    const categoryPath = path.join(versionDir, fileName);
    const parsedDocs = await readYamlDocuments(categoryPath);
    const rawRules = normalizeRulesFromDocuments(parsedDocs, categoryPath);

    for (let index = 0; index < rawRules.length; index += 1) {
      const validatedRule = validateRule(rawRules[index], category, index + 1, categoryPath);
      rules.push(validatedRule);
    }
  }

  if (manifest.rule_count !== rules.length) {
    throw new Error(
      `Rulepack ${version} rule_count mismatch in manifest: expected ${manifest.rule_count}, found ${rules.length}`,
    );
  }

  const ruleById = new Map<string, RulepackRule>();
  const categories = Object.values(RuleCategory) as RuleCategory[];
  const rulesByCategory = new Map<RuleCategory, RulepackRule[]>(
    categories.map((category) => [category, []]),
  );

  for (const rule of rules) {
    if (ruleById.has(rule.rule_id)) {
      throw new Error(`Duplicate rule_id detected: ${rule.rule_id}`);
    }

    ruleById.set(rule.rule_id, rule);
    const categoryRules = rulesByCategory.get(rule.category);

    if (!categoryRules) {
      throw new Error(`Unknown category when grouping rules: ${rule.category}`);
    }

    categoryRules.push(rule);
  }

  for (const categoryRules of rulesByCategory.values()) {
    categoryRules.sort((a, b) => {
      if (a.sort_order !== b.sort_order) {
        return a.sort_order - b.sort_order;
      }

      return a.rule_id.localeCompare(b.rule_id);
    });
  }

  const normalizedManifest: RulepackManifest = {
    ...manifest,
    checksum: manifest.checksum ?? '',
  };

  return {
    manifest: normalizedManifest,
    rules,
    rulesByCategory,
    ruleById,
  };
}

async function readYaml(pathToYaml: string): Promise<unknown> {
  try {
    const fileContent = await readFile(pathToYaml, 'utf8');
    const parsedDocs = parseAllDocuments(fileContent, { prettyErrors: false });
    const firstDoc = parsedDocs[0];

    if (!firstDoc) {
      throw new Error('YAML file is empty');
    }

    return firstDoc.toJSON();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Unable to read YAML file ${pathToYaml}: ${message}`);
  }
}

async function readYamlDocuments(pathToYaml: string): Promise<unknown[]> {
  try {
    const fileContent = await readFile(pathToYaml, 'utf8');
    const parsedDocs = parseAllDocuments(fileContent, { prettyErrors: false });

    return parsedDocs.map((document) => document.toJSON());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Unable to read YAML file ${pathToYaml}: ${message}`);
  }
}

function normalizeRulesFromDocuments(documents: unknown[], pathToYaml: string): unknown[] {
  const rules: unknown[] = [];

  for (const document of documents) {
    if (document === null || document === undefined) {
      continue;
    }

    if (Array.isArray(document)) {
      rules.push(...document);
      continue;
    }

    if (isRecord(document) && Array.isArray(document.rules)) {
      rules.push(...document.rules);
      continue;
    }

    if (isRecord(document)) {
      rules.push(document);
      continue;
    }

    throw new Error(
      `Invalid YAML document in ${pathToYaml}. Expected object, array, or { rules: [] } format.`,
    );
  }

  return rules;
}

function normalizeVersionTag(version: string): string {
  return version.trim().toLowerCase().replace(/^v/, '');
}

function buildVersionCandidates(version: string): string[] {
  const trimmed = version.trim();
  const withoutPrefix = trimmed.replace(/^v/i, '');
  const withPrefix = `v${withoutPrefix}`;

  const ordered = [trimmed, withPrefix, withoutPrefix];
  const unique = new Set<string>();

  for (const candidate of ordered) {
    if (candidate.length > 0) {
      unique.add(candidate);
    }
  }

  return [...unique];
}
function validateManifest(raw: unknown, version: string, pathToYaml: string): ParsedManifest {
  if (!isRecord(raw)) {
    throw new Error(`Invalid manifest in ${pathToYaml}: expected object`);
  }

  const manifestVersion = readRequiredString(raw, 'version', pathToYaml);

  if (normalizeVersionTag(manifestVersion) !== normalizeVersionTag(version)) {
    throw new Error(`Manifest version mismatch in ${pathToYaml}: expected ${version}, got ${manifestVersion}`);
  }

  const manifest: ParsedManifest = {
    version: manifestVersion,
    sha_policy_version: readRequiredString(raw, 'sha_policy_version', pathToYaml),
    description: readRequiredString(raw, 'description', pathToYaml),
    rule_count: readRequiredInteger(raw, 'rule_count', pathToYaml),
    checksum: readOptionalString(raw, 'checksum', pathToYaml),
  };

  if (manifest.rule_count < 0) {
    throw new Error(`Invalid manifest in ${pathToYaml}: rule_count must be >= 0`);
  }

  return manifest;
}

function validateRule(
  raw: unknown,
  expectedCategory: RuleCategory,
  defaultSortOrder: number,
  pathToYaml: string,
): RulepackRule {
  if (!isRecord(raw)) {
    throw new Error(`Invalid rule entry in ${pathToYaml}: expected object`);
  }

  const ruleId = readRequiredString(raw, 'rule_id', pathToYaml);
  const category = parseCategory(readRequiredString(raw, 'category', pathToYaml), pathToYaml, ruleId);

  if (category !== expectedCategory) {
    throw new Error(
      `Rule ${ruleId} has category ${category} but was declared in ${expectedCategory} file (${pathToYaml})`,
    );
  }

  const severity = parseSeverity(readRequiredString(raw, 'severity', pathToYaml), pathToYaml, ruleId);
  const logicKey = readRequiredString(raw, 'logic_key', pathToYaml);
  const appliesTo = readStringArray(raw, 'applies_to', pathToYaml, ruleId);
  const params = readObjectOrDefault(raw, 'params', pathToYaml, ruleId);
  const messageI18n = readLocaleMap(raw, 'message_i18n', pathToYaml, ruleId);
  const remediationI18n = readLocaleMap(raw, 'remediation_i18n', pathToYaml, ruleId);

  const isActiveValue = raw.is_active;
  const isActive = typeof isActiveValue === 'boolean' ? isActiveValue : true;

  const sortOrderValue = raw.sort_order;
  const sortOrder =
    typeof sortOrderValue === 'number' && Number.isFinite(sortOrderValue)
      ? Math.trunc(sortOrderValue)
      : defaultSortOrder;

  return {
    rule_id: ruleId,
    category,
    severity,
    logic_key: logicKey,
    applies_to: appliesTo,
    params,
    message_i18n: messageI18n,
    remediation_i18n: remediationI18n,
    is_active: isActive,
    sort_order: sortOrder,
  };
}

function parseCategory(rawCategory: string, pathToYaml: string, ruleId: string): RuleCategory {
  if (!isEnumValue(RuleCategory, rawCategory)) {
    throw new Error(`Rule ${ruleId} in ${pathToYaml} has invalid category: ${rawCategory}`);
  }

  return rawCategory;
}

function parseSeverity(rawSeverity: string, pathToYaml: string, ruleId: string): RuleSeverity {
  if (!isEnumValue(RuleSeverity, rawSeverity)) {
    throw new Error(`Rule ${ruleId} in ${pathToYaml} has invalid severity: ${rawSeverity}`);
  }

  return rawSeverity;
}

function readRequiredString(raw: Record<string, unknown>, key: string, pathToYaml: string): string {
  const value = raw[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing or invalid string field '${key}' in ${pathToYaml}`);
  }

  return value.trim();
}

function readOptionalString(raw: Record<string, unknown>, key: string, pathToYaml: string): string | undefined {
  const value = raw[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`Invalid optional string field '${key}' in ${pathToYaml}`);
  }

  return value;
}

function readRequiredInteger(raw: Record<string, unknown>, key: string, pathToYaml: string): number {
  const value = raw[key];

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Missing or invalid integer field '${key}' in ${pathToYaml}`);
  }

  return value;
}

function readStringArray(
  raw: Record<string, unknown>,
  key: string,
  pathToYaml: string,
  ruleId: string,
): string[] {
  const value = raw[key];

  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Rule ${ruleId} in ${pathToYaml} has invalid '${key}'. Expected non-empty string array.`);
  }

  return value;
}

function readObjectOrDefault(
  raw: Record<string, unknown>,
  key: string,
  pathToYaml: string,
  ruleId: string,
): Record<string, unknown> {
  const value = raw[key];

  if (value === undefined) {
    return {};
  }

  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`Rule ${ruleId} in ${pathToYaml} has invalid '${key}'. Expected object.`);
  }

  return value;
}

function readLocaleMap(
  raw: Record<string, unknown>,
  key: string,
  pathToYaml: string,
  ruleId: string,
): Record<string, string> {
  const value = raw[key];

  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`Rule ${ruleId} in ${pathToYaml} has invalid '${key}'. Expected object.`);
  }

  const localeMap: Record<string, string> = {};

  for (const [locale, message] of Object.entries(value)) {
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error(`Rule ${ruleId} in ${pathToYaml} has invalid ${key}.${locale}. Expected non-empty string.`);
    }

    localeMap[locale] = message;
  }

  if (!localeMap.en) {
    throw new Error(`Rule ${ruleId} in ${pathToYaml} must include ${key}.en`);
  }

  return localeMap;
}

function isEnumValue<T extends Record<string, string>>(enumType: T, value: string): value is T[keyof T] {
  return Object.values(enumType).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}







