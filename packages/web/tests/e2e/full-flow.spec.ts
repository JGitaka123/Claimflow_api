import { expect, test, type Route } from '@playwright/test';
import { apiOk, mockCreateClaim, setAuthenticatedSession, waitForHydration } from './helpers';

const CLAIM_ID = 'clm-e2e-fullflow-001';
const DOCUMENT_ID = 'doc-e2e-001';
const EXPORT_JOB_ID = '11111111-1111-1111-1111-111111111111';
const NAV_TIMEOUT_MS = 25_000;

test('full flow: create claim, upload document, open audit workspace, and trigger re-audit', async ({ page }) => {
  await setAuthenticatedSession(page);
  await mockCreateClaim(page, CLAIM_ID);

  const claimDetail = {
    claim: {
      id: CLAIM_ID,
      tenantId: '6a7f1fd1-a2b8-44e4-a6f9-9fd089c6a6b3',
      facilityId: '3ad5ab72-85a3-498d-8845-93f97c5dc215',
      patientShaId: 'CR123456789-1',
      patientName: 'Jane Doe',
      patientNationalId: '12345678',
      hmisRef: 'HMIS-REF-001',
      claimType: 'OUTPATIENT',
      visitType: 'OP',
      admissionDate: '2026-03-08',
      dischargeDate: null,
      primaryDiagnosisCode: 'CA40',
      shaBenefitPackage: 'OP_GENERAL',
      preauthNumber: null,
      accommodationType: null,
      patientDisposition: null,
      hospitalApprovedTotal: null,
      status: 'DOCUMENTS_UPLOADED',
      version: 1,
      lastAuditSessionId: 'audit-e2e-001',
      dedupHash: null,
      createdBy: 'user-e2e',
      createdAt: '2026-03-08T10:00:00.000Z',
      updatedAt: '2026-03-08T10:05:00.000Z',
      lines: [
        {
          id: 'line-e2e-001',
          claimId: CLAIM_ID,
          lineNumber: 1,
          shaServiceCode: 'SHA-001',
          description: 'Consultation',
          icdCode: null,
          procedureCode: null,
          caseCode: null,
          quantity: 1,
          unitPrice: 1500,
          totalAmount: 1500,
          billAmount: null,
          preauthNumber: null,
          status: 'PENDING',
          validationNotes: null,
          createdAt: '2026-03-08T10:00:00.000Z',
        },
      ],
    },
  };

  const documents: Array<{
    id: string;
    claimId: string;
    docType: string;
    processingRoute: string;
    processingStatus: string;
    mimeType: string;
    originalFilename: string;
    pageCount: number;
    fileSizeBytes: number;
    sha256: string;
    uploadedAt: string;
  }> = [];
  let exportStatusPollCount = 0;
  let exportDownloadRequested = false;

  await page.route(`**/v1/claims/${CLAIM_ID}`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk(claimDetail),
    });
  });

  await page.route(`**/v1/claims/${CLAIM_ID}/documents`, async (route: Route) => {
    if (route.request().method() === 'POST') {
      documents.splice(0, documents.length, {
        id: DOCUMENT_ID,
        claimId: CLAIM_ID,
        docType: 'SHA_CLAIM_FORM_OP',
        processingRoute: 'FULL_OCR_EXTRACT',
        processingStatus: 'PENDING',
        mimeType: 'application/pdf',
        originalFilename: 'claim-form.pdf',
        pageCount: 1,
        fileSizeBytes: 1024,
        sha256: 'abc123',
        uploadedAt: '2026-03-08T10:10:00.000Z',
      });

      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: apiOk({
          document: documents[0],
          pages: [{ id: 'page-e2e-001', pageNumber: 1, status: 'PENDING' }],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk(documents),
    });
  });

  await page.route(`**/v1/claims/${CLAIM_ID}/audit/latest`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        auditSession: {
          rulepackVersion: '1.0.0',
          decision: 'WARNING',
          failedCount: 0,
          warningCount: 1,
          incompleteCount: 0,
        },
        ruleResults: [
          {
            id: 'result-e2e-001',
            ruleId: 'DOC-001',
            result: 'WARNING',
            message: 'Document quality warning',
            remediation: 'Check document clarity',
            evidence: {
              documentId: DOCUMENT_ID,
              page: 1,
              field: 'patient_name',
            },
          },
        ],
      }),
    });
  });

  await page.route(`**/v1/claims/${CLAIM_ID}/export`, async (route: Route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: apiOk({
        jobId: EXPORT_JOB_ID,
        claimId: CLAIM_ID,
        auditSessionId: 'audit-e2e-002',
        status: 'QUEUED',
        createdAt: '2026-03-08T10:20:00.000Z',
      }),
    });
  });

  await page.route(`**/v1/jobs/${EXPORT_JOB_ID}`, async (route: Route) => {
    exportStatusPollCount += 1;
    const status = exportStatusPollCount >= 2 ? 'COMPLETED' : 'PROCESSING';

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        jobId: EXPORT_JOB_ID,
        type: 'EXPORT',
        claimId: CLAIM_ID,
        auditSessionId: 'audit-e2e-002',
        status,
        startedAt: '2026-03-08T10:20:01.000Z',
        completedAt: status === 'COMPLETED' ? '2026-03-08T10:20:04.000Z' : null,
        outputFileName: 'evidence-pack.zip',
        outputPath: status === 'COMPLETED' ? '/tmp/evidence-pack.zip' : null,
        error: null,
      }),
    });
  });

  await page.route(`**/v1/exports/${EXPORT_JOB_ID}/download`, async (route: Route) => {
    exportDownloadRequested = true;

    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="evidence-pack.zip"',
      },
      body: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    });
  });

  await page.route(`**/v1/documents/${DOCUMENT_ID}/pages/1/extraction`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        documentId: DOCUMENT_ID,
        pageNumber: 1,
        ocr: {
          confidence: 0.92,
          rawText: 'CLAIMFLOW QUALITY TEST',
        },
        fields: [
          {
            id: 'field-e2e-001',
            fieldKey: 'patient_name',
            value: 'Jane Doe',
            confidence: 0.84,
            confidenceTier: 'MEDIUM',
            bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.08 },
            source: 'OCR',
          },
        ],
      }),
    });
  });

  await page.route(`**/v1/documents/${DOCUMENT_ID}/download`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: '%PDF-1.4\n%EOF\n',
    });
  });

  await page.route(`**/v1/claims/${CLAIM_ID}/audit`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        auditSessionId: 'audit-e2e-002',
      }),
    });
  });

  await page.goto('/claims/new', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  await page.getByLabel(/Facility ID/i).fill('3ad5ab72-85a3-498d-8845-93f97c5dc215');
  await page.getByLabel(/Admission Date/i).fill('2026-03-08');
  await page.getByLabel(/Service Code/i).first().fill('SHA-001');
  await page.getByLabel(/Description/i).first().fill('Consultation');
  await page.getByLabel(/Unit Price/i).first().fill('1500');
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/v1/claims') &&
        response.status() === 200,
      { timeout: NAV_TIMEOUT_MS },
    ),
    page.getByRole('button', { name: 'Create Claim' }).click(),
  ]);

  await expect(page).toHaveURL(`/claims/${CLAIM_ID}`, { timeout: NAV_TIMEOUT_MS });
  await expect(page.getByRole('heading', { name: `Claim ${CLAIM_ID}` })).toBeVisible({ timeout: NAV_TIMEOUT_MS });

  await page.getByLabel('File').setInputFiles({
    name: 'claim-form.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%EOF\n'),
  });

  await page.getByRole('button', { name: 'Upload Document' }).click();

  await expect(page.getByText('Document uploaded successfully.')).toBeVisible({ timeout: NAV_TIMEOUT_MS });
  await expect(page.getByText('claim-form.pdf')).toBeVisible({ timeout: NAV_TIMEOUT_MS });

  await Promise.all([
    page.waitForURL(`**/claims/${CLAIM_ID}/audit`, { timeout: NAV_TIMEOUT_MS }),
    page.getByRole('link', { name: 'Open Audit Workspace' }).click(),
  ]);

  await expect(page).toHaveURL(`/claims/${CLAIM_ID}/audit`, { timeout: NAV_TIMEOUT_MS });
  await expect(page.getByRole('heading', { name: `Audit Workspace - ${CLAIM_ID}` })).toBeVisible({ timeout: NAV_TIMEOUT_MS });

  await page.getByRole('button', { name: 'Re-audit' }).click();
  await expect(page.getByText('Re-audit triggered')).toBeVisible({ timeout: NAV_TIMEOUT_MS });

  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByText(`Evidence pack downloaded for ${CLAIM_ID}`)).toBeVisible({ timeout: NAV_TIMEOUT_MS });
  expect(exportDownloadRequested).toBeTruthy();
});
