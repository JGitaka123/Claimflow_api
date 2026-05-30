import type { Page, Route } from '@playwright/test';

const AUTH_COOKIE_NAME = 'cf_access_token';
const AUTH_COOKIE_VALUE = 'e2e-access-token';
const HYDRATION_MARKER = 'data-cf-hydrated';

interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

interface SessionOptions {
  user?: Partial<SessionUser>;
  accessToken?: string;
  refreshToken?: string;
}

const DEFAULT_SESSION_USER: SessionUser = {
  id: 'user-e2e',
  email: 'officer@hospital.org',
  displayName: 'E2E Officer',
  role: 'claims_officer',
};

function resolveSessionUser(user?: Partial<SessionUser>): SessionUser {
  return {
    ...DEFAULT_SESSION_USER,
    ...user,
  };
}

export function apiOk<T>(data: T, meta: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data,
    meta: {
      requestId: 'e2e-request-id',
      ...meta,
    },
  });
}

export async function setAuthenticatedSession(page: Page, options: SessionOptions = {}): Promise<void> {
  const accessToken = options.accessToken ?? AUTH_COOKIE_VALUE;
  const refreshToken = options.refreshToken ?? 'e2e-refresh-token';
  const sessionUser = resolveSessionUser(options.user);

  await page.context().addCookies([
    {
      name: AUTH_COOKIE_NAME,
      value: accessToken,
      domain: '127.0.0.1',
      path: '/',
      sameSite: 'Lax',
    },
  ]);

  await page.addInitScript(
    ({ token, refresh }) => {
      window.localStorage.setItem('cf_access_token', token);
      window.localStorage.setItem('cf_refresh_token', refresh);
      document.cookie = `cf_access_token=${encodeURIComponent(token)}; path=/; samesite=lax`;
      document.cookie = `cf_refresh_token=${encodeURIComponent(refresh)}; path=/; samesite=lax`;
    },
    { token: accessToken, refresh: refreshToken },
  );

  await mockAuthMe(page, sessionUser);
}

export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    (marker) => document.documentElement.getAttribute(marker) === 'true',
    HYDRATION_MARKER,
  );
}

export async function mockAuthMe(page: Page, user: SessionUser = DEFAULT_SESSION_USER): Promise<void> {
  await page.route('**/v1/auth/me', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        user,
      }),
    });
  });
}

export async function mockDashboardApis(page: Page): Promise<void> {
  await page.route('**/v1/dashboard/overview', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        claimsToday: 8,
        claimsThisWeek: 41,
        passRate: 84.2,
        pendingAudit: 3,
        avgAuditTimeSec: 95.4,
        mlStatus: 'HEALTHY',
        mlLatencyMs: 148,
        queueDepth: 2,
        avgOcrConfidence: 0.93,
        claimsByStatus: [
          { status: 'PASSED', count: 21 },
          { status: 'FAILED', count: 4 },
          { status: 'WARNING', count: 6 },
        ],
        trend: [
          { date: '2026-03-01', passed: 6, failed: 1, warning: 2 },
          { date: '2026-03-02', passed: 8, failed: 1, warning: 1 },
        ],
        claimsByType: [
          { type: 'OUTPATIENT', count: 18 },
          { type: 'INPATIENT', count: 9 },
        ],
        documentProcessing: {
          totalDocs: 73,
          completedDocs: 69,
          failedDocs: 4,
        },
      }),
    });
  });

  await page.route('**/v1/dashboard/rules/top-failures**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        period: '30d',
        items: [
          {
            ruleId: 'DOC-005',
            failures: 12,
            affectedClaims: 8,
            previousFailures: 10,
            trendPercent: 20,
          },
        ],
      }),
    });
  });

  await page.route('**/v1/dashboard/document-quality**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        period: '30d',
        items: [
          {
            docType: 'CLAIM_FORM',
            documentsCount: 15,
            avgOcrConfidence: 0.95,
            manualEntryRate: 0.08,
          },
        ],
      }),
    });
  });
}

export async function mockClaimsList(page: Page): Promise<void> {
  await page.route('**/v1/claims?**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk(
        [
          {
            id: 'clm-e2e-001',
            facilityId: '3ad5ab72-85a3-498d-8845-93f97c5dc215',
            claimType: 'OUTPATIENT',
            status: 'DOCUMENTS_UPLOADED',
            admissionDate: '2026-03-06',
            patientShaId: 'CR123456789-1',
            totalAmount: 3500,
            currency: 'KES',
            lineCount: 1,
            documentCount: 2,
            createdBy: 'user-e2e',
            createdAt: '2026-03-06T10:00:00.000Z',
            updatedAt: '2026-03-06T11:00:00.000Z',
            version: 1,
            lastAuditDecision: 'WARNING',
            lastAuditedAt: '2026-03-06T11:15:00.000Z',
          },
        ],
        {
          hasMore: false,
          cursor: null,
        },
      ),
    });
  });
}

export async function mockClaimDetail(page: Page, claimId: string): Promise<void> {
  await page.route(`**/v1/claims/${claimId}`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        claim: {
          id: claimId,
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
          primaryDiagnosisCode: null,
          shaBenefitPackage: null,
          preauthNumber: null,
          accommodationType: null,
          patientDisposition: null,
          hospitalApprovedTotal: null,
          status: 'DOCUMENTS_UPLOADED',
          version: 1,
          lastAuditSessionId: null,
          dedupHash: null,
          createdBy: 'user-e2e',
          createdAt: '2026-03-08T10:00:00.000Z',
          updatedAt: '2026-03-08T10:00:00.000Z',
          lines: [],
        },
      }),
    });
  });

  await page.route(`**/v1/claims/${claimId}/documents`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk([]),
    });
  });
}

export async function mockCreateClaim(page: Page, claimId: string): Promise<void> {
  await page.route('**/v1/claims', async (route: Route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({ claim: { id: claimId } }),
    });
  });
}

