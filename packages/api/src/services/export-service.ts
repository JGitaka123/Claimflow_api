import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import archiver from 'archiver';
import React from 'react';
import { Document, Page, Text, View, StyleSheet, pdf } from '@react-pdf/renderer';
import { DomainError, ErrorCode } from '@claimflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { QueryResultRow } from 'pg';
import type { TenantDb } from '../db/client.js';
import type { Config } from '../config.js';
import { createLocalFsDocumentStore } from '../storage/local-fs-store.js';
import { createAuditPipelineService } from '../workflows/audit-pipeline.js';

interface ClaimExportRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  facility_id: string;
  status: string;
  claim_type: string;
  patient_sha_id: string | null;
  patient_name_enc: string | null;
  admission_date: string | Date;
  discharge_date: string | Date | null;
  primary_diagnosis_code: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  facility_name: string;
  facility_sha_code: string | null;
  facility_tier: string | null;
}

interface DocumentExportRow extends QueryResultRow {
  id: string;
  doc_type: string;
  mime_type: string;
  original_filename: string;
  page_count: number;
  storage_path: string;
  sha256: string;
  uploaded_at: string | Date;
}

interface EnsureAuditSessionRow extends QueryResultRow {
  id: string;
}

interface GenerateEvidencePackParams {
  tenantId: string;
  claimId: string;
  auditSessionId: string;
  requestedByUserId: string;
  locale?: 'en' | 'sw';
}

interface GenerateEvidencePackResult {
  outputPath: string;
  outputFileName: string;
  claimId: string;
  auditSessionId: string;
}

interface EnsureAuditSessionParams {
  tenantId: string;
  claimId: string;
  auditSessionId?: string;
}

interface ExportHashManifest {
  file_hashes: Record<string, string>;
}

interface LocalizedFixReportCopy {
  title: string;
  claimIdLabel: string;
  facilityLabel: string;
  generatedAtLabel: string;
  sectionCritical: string;
  sectionWarnings: string;
  sectionSuggestedFixes: string;
  sectionPassedRules: string;
  noneReported: string;
  reviewRuleResults: string;
  passedCountLabel: string;
}

const FIX_REPORT_COPY: Record<'en' | 'sw', LocalizedFixReportCopy> = {
  en: {
    title: 'ClaimFlow Audit Fix Report',
    claimIdLabel: 'Claim ID',
    facilityLabel: 'Facility',
    generatedAtLabel: 'Generated At',
    sectionCritical: 'Critical Issues',
    sectionWarnings: 'Warnings',
    sectionSuggestedFixes: 'Suggested Fixes',
    sectionPassedRules: 'Passed Rules',
    noneReported: 'None reported',
    reviewRuleResults: 'Review rule results in audit_result.json',
    passedCountLabel: 'Passed count',
  },
  sw: {
    title: 'Ripoti ya Marekebisho ya Ukaguzi wa ClaimFlow',
    claimIdLabel: 'Nambari ya Dai',
    facilityLabel: 'Kituo',
    generatedAtLabel: 'Ilitengenezwa',
    sectionCritical: 'Masuala Muhimu',
    sectionWarnings: 'Maonyo',
    sectionSuggestedFixes: 'Marekebisho Yanayopendekezwa',
    sectionPassedRules: 'Sheria Zilizopita',
    noneReported: 'Hakuna lililoripotiwa',
    reviewRuleResults: 'Kagua matokeo ya sheria kwenye audit_result.json',
    passedCountLabel: 'Idadi iliyopita',
  },
};

function resolveFixReportLocale(locale?: string): 'en' | 'sw' {
  return locale?.toLowerCase().startsWith('sw') ? 'sw' : 'en';
}

const pdfStyles = StyleSheet.create({
  page: {
    fontSize: 10,
    paddingTop: 24,
    paddingBottom: 24,
    paddingHorizontal: 24,
    fontFamily: 'Helvetica',
    lineHeight: 1.4,
  },
  headerBlock: {
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#d4d4d8',
    paddingBottom: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: 700,
    marginBottom: 6,
  },
  subLine: {
    fontSize: 10,
    marginBottom: 2,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 700,
    marginTop: 10,
    marginBottom: 4,
  },
  bodyLine: {
    fontSize: 10,
    marginBottom: 3,
  },
});

function toIsoString(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }

  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'file.bin';
}

function markdownToLines(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, array) => {
      if (line.length > 0) {
        return true;
      }

      return index > 0 && array[index - 1] !== '';
    });
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function zipDirectory(sourceDir: string, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 9 },
    });

    output.on('close', () => resolvePromise());
    output.on('error', rejectPromise);
    archive.on('error', rejectPromise);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}

export class ExportService {
  private readonly auditPipeline: ReturnType<typeof createAuditPipelineService>;
  private readonly documentStore: ReturnType<typeof createLocalFsDocumentStore>;

  constructor(
    private readonly pool: TenantDb,
    private readonly logger: FastifyBaseLogger,
    private readonly config: Config,
  ) {
    this.auditPipeline = createAuditPipelineService(this.pool, this.logger, this.config);
    this.documentStore = createLocalFsDocumentStore(this.config.STORAGE_PATH);
  }

  async ensureAuditSession(params: EnsureAuditSessionParams): Promise<string> {
    if (params.auditSessionId) {
      const explicit = await this.pool.query<EnsureAuditSessionRow>(
        `SELECT a.id
           FROM audit_sessions a
           JOIN claims c ON c.id = a.claim_id
          WHERE a.id = $1::uuid
            AND a.claim_id = $2::uuid
            AND c.tenant_id = $3::uuid
          LIMIT 1`,
        [params.auditSessionId, params.claimId, params.tenantId],
      );

      const row = explicit.rows[0];

      if (!row) {
        throw new DomainError(ErrorCode.NOT_FOUND, 'Audit session not found for claim');
      }

      return row.id;
    }

    const latest = await this.pool.query<EnsureAuditSessionRow>(
      `SELECT a.id
         FROM audit_sessions a
         JOIN claims c ON c.id = a.claim_id
        WHERE a.claim_id = $1::uuid
          AND c.tenant_id = $2::uuid
        ORDER BY a.started_at DESC
        LIMIT 1`,
      [params.claimId, params.tenantId],
    );

    const latestRow = latest.rows[0];

    if (!latestRow) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'No audit session found for claim export');
    }

    return latestRow.id;
  }

  async generateFixReportPdf(input: {
    claimId: string;
    facilityName: string;
    generatedAtIso: string;
    markdown: string;
    locale?: 'en' | 'sw';
  }): Promise<Buffer> {
    const lines = markdownToLines(input.markdown);
    const copy = FIX_REPORT_COPY[resolveFixReportLocale(input.locale)];

    const docElement = React.createElement(
      Document,
      null,
      React.createElement(
        Page,
        { size: 'A4', style: pdfStyles.page },
        React.createElement(
          View,
          { style: pdfStyles.headerBlock },
          React.createElement(Text, { style: pdfStyles.title }, copy.title),
          React.createElement(Text, { style: pdfStyles.subLine }, `${copy.claimIdLabel}: ${input.claimId}`),
          React.createElement(Text, { style: pdfStyles.subLine }, `${copy.facilityLabel}: ${input.facilityName}`),
          React.createElement(Text, { style: pdfStyles.subLine }, `${copy.generatedAtLabel}: ${input.generatedAtIso}`),
        ),
        ...lines.map((line, index) => {
          const trimmed = line.trim();

          if (trimmed.startsWith('#')) {
            const title = trimmed.replace(/^#+\s*/, '');
            return React.createElement(Text, { key: `h-${index}`, style: pdfStyles.sectionTitle }, title);
          }

          const normalizedLine = trimmed.startsWith('- ') ? '- ' + trimmed.slice(2) : line;

          return React.createElement(Text, { key: `l-${index}`, style: pdfStyles.bodyLine }, normalizedLine);
        }),
      ),
    );

    const instance = pdf(docElement);
    const generated = await instance.toBuffer();

    if (Buffer.isBuffer(generated)) {
      return generated;
    }

    if (generated instanceof Uint8Array) {
      return Buffer.from(generated);
    }

    if (generated && typeof (generated as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
      const chunks: Buffer[] = [];

      for await (const chunk of generated as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }

      return Buffer.concat(chunks);
    }

    throw new Error('Unable to serialize PDF output');
  }

  async generateEvidencePack(params: GenerateEvidencePackParams): Promise<GenerateEvidencePackResult> {
    const claimRowResult = await this.pool.query<ClaimExportRow>(
      `SELECT
          c.id,
          c.tenant_id,
          c.facility_id,
          c.status::text AS status,
          c.claim_type::text AS claim_type,
          c.patient_sha_id,
          c.patient_name_enc,
          c.admission_date,
          c.discharge_date,
          c.primary_diagnosis_code,
          c.created_at,
          c.updated_at,
          f.name AS facility_name,
          f.sha_facility_code AS facility_sha_code,
          f.tier_level AS facility_tier
        FROM claims c
        JOIN facilities f ON f.id = c.facility_id
       WHERE c.id = $1::uuid
         AND c.tenant_id = $2::uuid
       LIMIT 1`,
      [params.claimId, params.tenantId],
    );

    const claimRow = claimRowResult.rows[0];

    if (!claimRow) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Claim not found');
    }

    const auditResult = await this.auditPipeline.getAuditById({
      auditId: params.auditSessionId,
      tenantId: params.tenantId,
    });

    const documentsResult = await this.pool.query<DocumentExportRow>(
      `SELECT
          d.id,
          d.doc_type::text AS doc_type,
          d.mime_type,
          d.original_filename,
          d.page_count,
          d.storage_path,
          d.sha256,
          d.uploaded_at
         FROM documents d
         JOIN claims c ON c.id = d.claim_id
        WHERE d.claim_id = $1::uuid
          AND c.tenant_id = $2::uuid
        ORDER BY d.uploaded_at ASC`,
      [params.claimId, params.tenantId],
    );

    const exportDir = resolve(this.config.STORAGE_PATH, 'exports', params.tenantId, params.claimId);
    const tempDir = resolve(exportDir, `${params.auditSessionId}-work-${randomUUID()}`);
    const documentsTempDir = resolve(tempDir, 'documents');
    const outputFileName = `${params.auditSessionId}.zip`;
    const outputPath = resolve(exportDir, outputFileName);

    await mkdir(documentsTempDir, { recursive: true });

    try {
      const generatedAtIso = new Date().toISOString();
      const copy = FIX_REPORT_COPY[resolveFixReportLocale(params.locale)];
      const fixReportMarkdown = auditResult.auditSession.fixReportMd ?? [
        `# ${copy.sectionCritical}`,
        `- ${copy.noneReported}`,
        `# ${copy.sectionWarnings}`,
        `- ${copy.noneReported}`,
        `# ${copy.sectionSuggestedFixes}`,
        `- ${copy.reviewRuleResults}`,
        `# ${copy.sectionPassedRules}`,
        `- ${copy.passedCountLabel}: ${auditResult.auditSession.passedCount}`,
      ].join('\n');

      const reportPdf = await this.generateFixReportPdf({
        claimId: params.claimId,
        facilityName: claimRow.facility_name,
        generatedAtIso,
        markdown: fixReportMarkdown,
        locale: resolveFixReportLocale(params.locale),
      });

      const fileHashes: Record<string, string> = {};

      const reportPdfPath = resolve(tempDir, 'audit_report.pdf');
      await writeFile(reportPdfPath, reportPdf);
      fileHashes['audit_report.pdf'] = hashBuffer(reportPdf);

      const auditResultJson = Buffer.from(JSON.stringify(auditResult, null, 2), 'utf8');
      const auditResultPath = resolve(tempDir, 'audit_result.json');
      await writeFile(auditResultPath, auditResultJson);
      fileHashes['audit_result.json'] = hashBuffer(auditResultJson);

      const metadataPayload = {
        claim: {
          id: claimRow.id,
          status: claimRow.status,
          claimType: claimRow.claim_type,
          patientShaId: claimRow.patient_sha_id,
          patientName: claimRow.patient_name_enc,
          admissionDate: toIsoString(claimRow.admission_date),
          dischargeDate: toIsoString(claimRow.discharge_date),
          primaryDiagnosisCode: claimRow.primary_diagnosis_code,
          createdAt: toIsoString(claimRow.created_at),
          updatedAt: toIsoString(claimRow.updated_at),
        },
        facility: {
          id: claimRow.facility_id,
          name: claimRow.facility_name,
          shaFacilityCode: claimRow.facility_sha_code,
          tier: claimRow.facility_tier,
        },
        audit: {
          auditSessionId: auditResult.auditSession.id,
          rulepackVersion: auditResult.auditSession.rulepackVersion,
          rulepackChecksum: auditResult.auditSession.rulepackChecksum,
          decision: auditResult.auditSession.decision,
          startedAt: auditResult.auditSession.startedAt,
          completedAt: auditResult.auditSession.completedAt,
        },
        generatedAt: generatedAtIso,
        generatedByUserId: params.requestedByUserId,
      };

      const metadataBuffer = Buffer.from(JSON.stringify(metadataPayload, null, 2), 'utf8');
      const metadataPath = resolve(tempDir, 'metadata.json');
      await writeFile(metadataPath, metadataBuffer);
      fileHashes['metadata.json'] = hashBuffer(metadataBuffer);

      for (const documentRow of documentsResult.rows) {
        const documentBytes = await this.documentStore.get(documentRow.storage_path);
        const documentFileName = `${documentRow.id}-${sanitizeFilename(documentRow.original_filename)}`;
        const relativePath = `documents/${documentFileName}`;
        const absolutePath = resolve(documentsTempDir, documentFileName);

        await writeFile(absolutePath, documentBytes);
        fileHashes[relativePath] = hashBuffer(documentBytes);
      }

      const hashManifest: ExportHashManifest = {
        file_hashes: fileHashes,
      };

      const hashManifestBuffer = Buffer.from(JSON.stringify(hashManifest, null, 2), 'utf8');
      const hashManifestPath = resolve(tempDir, 'file_hashes.json');
      await writeFile(hashManifestPath, hashManifestBuffer);

      await zipDirectory(tempDir, outputPath);

      await this.pool.query(
        `UPDATE audit_sessions
            SET fix_report_pdf_path = $2
          WHERE id = $1::uuid`,
        [params.auditSessionId, outputPath],
      );

      await this.pool.query(
        `INSERT INTO audit_trail (
            tenant_id,
            claim_id,
            user_id,
            action,
            detail_json
          ) VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            'CLAIM_EXPORTED'::audit_action,
            $4::jsonb
          )`,
        [
          params.tenantId,
          params.claimId,
          params.requestedByUserId,
          JSON.stringify({
            auditSessionId: params.auditSessionId,
            outputPath,
            outputFileName,
            documentCount: documentsResult.rows.length,
            generatedAt: generatedAtIso,
          }),
        ],
      );

      this.logger.info(
        {
          claimId: params.claimId,
          auditSessionId: params.auditSessionId,
          outputPath,
          documentCount: documentsResult.rows.length,
        },
        'evidence pack generated',
      );

      return {
        outputPath,
        outputFileName,
        claimId: params.claimId,
        auditSessionId: params.auditSessionId,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async openEvidencePackStream(outputPath: string): Promise<ReturnType<typeof createReadStream>> {
    const exportsRoot = resolve(this.config.STORAGE_PATH, 'exports');
    const safePath = resolve(outputPath);

    if (!safePath.startsWith(exportsRoot)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Invalid export path');
    }

    await readFile(safePath);

    return createReadStream(safePath);
  }
}

export function createExportService(pool: TenantDb, logger: FastifyBaseLogger, config: Config): ExportService {
  return new ExportService(pool, logger, config);
}