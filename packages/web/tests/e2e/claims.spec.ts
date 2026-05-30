import { expect, test } from '@playwright/test';
import { mockClaimDetail, mockClaimsList, mockCreateClaim, setAuthenticatedSession, waitForHydration } from './helpers';

const NAV_TIMEOUT_MS = 25_000;

test('renders claims queue and opens claim details', async ({ page }) => {
  await setAuthenticatedSession(page);
  await mockClaimsList(page);
  await mockClaimDetail(page, 'clm-e2e-001');

  await page.goto('/claims', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  await expect(page.getByRole('heading', { name: 'Claims Queue' })).toBeVisible({ timeout: NAV_TIMEOUT_MS });
  await expect(page.getByRole('link', { name: 'clm-e2e-001' })).toBeVisible({ timeout: NAV_TIMEOUT_MS });

  await Promise.all([
    page.waitForURL('**/claims/clm-e2e-001', { timeout: NAV_TIMEOUT_MS }),
    page.getByRole('link', { name: 'clm-e2e-001' }).click(),
  ]);

  await expect(page).toHaveURL('/claims/clm-e2e-001', { timeout: NAV_TIMEOUT_MS });
  await expect(page.getByRole('heading', { name: /Claim clm-e2e-001/i })).toBeVisible({ timeout: NAV_TIMEOUT_MS });
});

test('creates a new claim and redirects to claim detail', async ({ page }) => {
  await setAuthenticatedSession(page);
  await mockCreateClaim(page, 'clm-created-001');
  await mockClaimDetail(page, 'clm-created-001');

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

  await expect(page).toHaveURL('/claims/clm-created-001', { timeout: NAV_TIMEOUT_MS });
  await expect(page.getByRole('heading', { name: /Claim clm-created-001/i })).toBeVisible({ timeout: NAV_TIMEOUT_MS });
});

test('exports evidence pack from claims queue', async ({ page }) => {
  await setAuthenticatedSession(page);
  await mockClaimsList(page);

  let statusPollCount = 0;

  await page.route('**/v1/claims/clm-e2e-001/export', async (route) => {
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          jobId: 'export-job-001',
          claimId: 'clm-e2e-001',
          auditSessionId: 'audit-e2e-001',
          status: 'QUEUED',
          createdAt: '2026-03-09T10:00:00.000Z',
        },
        meta: {
          requestId: 'e2e-request-id',
        },
      }),
    });
  });

  await page.route('**/v1/jobs/export-job-001', async (route) => {
    statusPollCount += 1;

    const status = statusPollCount < 2 ? 'PROCESSING' : 'COMPLETED';

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          jobId: 'export-job-001',
          type: 'EXPORT',
          claimId: 'clm-e2e-001',
          auditSessionId: 'audit-e2e-001',
          status,
          startedAt: '2026-03-09T10:00:01.000Z',
          completedAt: status === 'COMPLETED' ? '2026-03-09T10:00:03.000Z' : null,
          outputFileName: status === 'COMPLETED' ? 'clm-e2e-001-evidence-pack.zip' : null,
          outputPath: status === 'COMPLETED' ? '/tmp/evidence.zip' : null,
          error: null,
        },
        meta: {
          requestId: 'e2e-request-id',
        },
      }),
    });
  });

  await page.route('**/v1/exports/export-job-001/download', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/zip',
      headers: {
        'content-disposition': 'attachment; filename="clm-e2e-001-evidence-pack.zip"',
      },
      body: 'fake-zip-content',
    });
  });

  await page.goto('/claims', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  const claimRow = page.locator('tr', { has: page.getByRole('link', { name: 'clm-e2e-001' }) });

  await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST' && request.url().includes('/v1/claims/clm-e2e-001/export'), {
      timeout: NAV_TIMEOUT_MS,
    }),
    claimRow.getByRole('button', { name: 'Export' }).click(),
  ]);

  await page.waitForRequest((request) => request.method() === 'GET' && request.url().includes('/v1/exports/export-job-001/download'), {
    timeout: NAV_TIMEOUT_MS,
  });

  await expect(page.getByText('Evidence pack downloaded for clm-e2e-001')).toBeVisible({ timeout: NAV_TIMEOUT_MS });
  expect(statusPollCount).toBeGreaterThan(0);
});
