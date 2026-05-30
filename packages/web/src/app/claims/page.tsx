'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import type { ClaimStatus, ClaimType, ClaimSummary } from '@claimflow/shared';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ApiClientError, apiClient } from '@/lib/api-client';

type SortField = 'createdAt' | 'updatedAt' | 'admissionDate';
type SortOrder = 'asc' | 'desc';

interface ClaimsResponseMeta {
  cursor?: string | null;
  hasMore?: boolean;
}

interface ClaimsQueryState {
  statuses: ClaimStatus[];
  claimType: ClaimType | '';
  dateFrom: string;
  dateTo: string;
  q: string;
}

interface ClaimRow extends ClaimSummary {}

interface BatchAuditQueueResponse {
  jobId: string;
  totalClaims: number;
  status: 'QUEUED';
  createdAt: string;
}

interface BatchAuditJobStatus {
  jobId: string;
  type: 'BATCH_AUDIT';
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  totalClaims: number;
  processedClaims: number;
  passedCount: number;
  failedCount: number;
  warningCount: number;
  errorCount: number;
  errors: Array<{ claimId: string; error: string }>;
  startedAt: string | null;
  completedAt: string | null;
  results: Array<{ claimId: string; auditSessionId: string | null; decision: string | null }>;
}

interface ExportQueueResponse {
  jobId: string;
  claimId: string;
  auditSessionId: string;
  status: 'QUEUED';
  createdAt: string;
}

interface ExportJobStatus {
  jobId: string;
  type: 'EXPORT';
  claimId: string;
  auditSessionId: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  startedAt: string | null;
  completedAt: string | null;
  outputFileName: string | null;
  outputPath: string | null;
  error: string | null;
}

const STATUS_FILTER_OPTIONS: ClaimStatus[] = [
  'DRAFT' as ClaimStatus,
  'DOCUMENTS_UPLOADED' as ClaimStatus,
  'PROCESSING' as ClaimStatus,
  'PASSED' as ClaimStatus,
  'WARNING' as ClaimStatus,
  'FAILED' as ClaimStatus,
  'CORRECTIONS_IN_PROGRESS' as ClaimStatus,
  'OVERRIDE_PENDING' as ClaimStatus,
  'OVERRIDE_APPROVED' as ClaimStatus,
];

const CLAIM_TYPE_OPTIONS: ClaimType[] = [
  'OUTPATIENT' as ClaimType,
  'INPATIENT' as ClaimType,
  'MATERNITY' as ClaimType,
  'DENTAL' as ClaimType,
  'OPTICAL' as ClaimType,
  'MENTAL_HEALTH' as ClaimType,
  'RENAL' as ClaimType,
  'SURGICAL' as ClaimType,
  'EMERGENCY' as ClaimType,
];

const DEFAULT_FILTERS: ClaimsQueryState = {
  statuses: [],
  claimType: '',
  dateFrom: '',
  dateTo: '',
  q: '',
};

function formatMoneyKes(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'KES',
    minimumFractionDigits: 2,
  }).format(value);
}

function formatDate(value: string, locale: string): string {
  return new Date(value).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}


function resolveApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:8080';
}

function getAccessTokenFromBrowser(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const fromStorage = window.localStorage.getItem('cf_access_token');
  if (fromStorage && fromStorage.length > 0) {
    return fromStorage;
  }

  const fromCookie = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('cf_access_token='));

  if (!fromCookie) {
    return null;
  }

  return decodeURIComponent(fromCookie.split('=').slice(1).join('='));
}

function parseDownloadFilename(contentDisposition: string | null, fallback: string): string {
  if (!contentDisposition) {
    return fallback;
  }

  const match = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (!match?.[1]) {
    return fallback;
  }

  return match[1];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
function nextSort(currentField: SortField, activeField: SortField, activeOrder: SortOrder): SortOrder {
  if (currentField !== activeField) {
    return 'desc';
  }

  return activeOrder === 'desc' ? 'asc' : 'desc';
}

function SortHeader(props: {
  label: string;
  field: SortField;
  activeField: SortField;
  activeOrder: SortOrder;
  onSort: (field: SortField) => void;
}): JSX.Element {
  const isActive = props.activeField === props.field;
  const direction = isActive ? (props.activeOrder === 'asc' ? '^' : 'v') : '';

  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-left text-xs font-semibold uppercase tracking-[0.06em]"
      onClick={() => props.onSort(props.field)}
    >
      <span>{props.label}</span>
      <span className="text-[var(--muted)]">{direction}</span>
    </button>
  );
}

export default function ClaimsPage(): JSX.Element {
  const t = useTranslations('claimsPage');
  const tCommon = useTranslations('common');
  const tClaimStatus = useTranslations('claims.status');
  const tClaimTypes = useTranslations('claims.types');
  const locale = useLocale().startsWith('sw') ? 'sw-KE' : 'en-KE';

  const [draftFilters, setDraftFilters] = useState<ClaimsQueryState>(DEFAULT_FILTERS);
  const [filters, setFilters] = useState<ClaimsQueryState>(DEFAULT_FILTERS);
  const [sortBy, setSortBy] = useState<SortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [activeBatchJobId, setActiveBatchJobId] = useState<string | null>(null);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [activeExportClaimId, setActiveExportClaimId] = useState<string | null>(null);
  const [activeExportJob, setActiveExportJob] = useState<{ claimId: string; jobId: string; status: ExportJobStatus['status'] } | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const claimsQuery = useQuery({
    queryKey: ['claims-list', filters, sortBy, sortOrder, cursor],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('limit', '25');
      params.set('sortBy', sortBy);
      params.set('sortOrder', sortOrder);

      if (cursor) {
        params.set('cursor', cursor);
      }

      if (filters.statuses.length > 0) {
        params.set('status', filters.statuses.join(','));
      }

      if (filters.claimType) {
        params.set('claimType', filters.claimType);
      }

      if (filters.dateFrom) {
        params.set('dateFrom', filters.dateFrom);
      }

      if (filters.dateTo) {
        params.set('dateTo', filters.dateTo);
      }

      if (filters.q.trim().length > 0) {
        params.set('q', filters.q.trim());
      }

      return apiClient.get<ClaimRow[]>(`/v1/claims?${params.toString()}`);
    },
  });

  const startBatchAuditMutation = useMutation({
    mutationFn: async () => {
      return apiClient.post<BatchAuditQueueResponse>('/v1/claims/batch-audit', {
        body: {
          filter: {
            status: 'DOCUMENTS_UPLOADED',
          },
          concurrency: 4,
        },
      });
    },
    onSuccess: (response) => {
      setActiveBatchJobId(response.data.jobId);
      setShowBatchModal(true);
    },
  });

  const batchJobStatusQuery = useQuery({
    queryKey: ['batch-audit-status', activeBatchJobId],
    enabled: Boolean(activeBatchJobId),
    queryFn: async () => {
      return apiClient.get<BatchAuditJobStatus>(`/v1/jobs/${activeBatchJobId}`);
    },
    refetchInterval: (query) => {
      const state = query.state.data?.data.status;

      if (!state) {
        return 2000;
      }

      if (state === 'COMPLETED' || state === 'FAILED') {
        return false;
      }

      return 2000;
    },
  });


  const exportClaimMutation = useMutation({
    mutationFn: async (claimId: string) => {
      setActiveExportClaimId(claimId);
      setExportNotice(null);

      const enqueueResponse = await apiClient.post<ExportQueueResponse>(`/v1/claims/${claimId}/export`, {
        body: {},
      });

      const { jobId } = enqueueResponse.data;
      setActiveExportJob({ claimId, jobId, status: 'QUEUED' });

      let exportStatus: ExportJobStatus | null = null;

      for (let attempt = 0; attempt < 45; attempt += 1) {
        const statusResponse = await apiClient.get<ExportJobStatus>(`/v1/jobs/${jobId}`);
        exportStatus = statusResponse.data;
        setActiveExportJob({ claimId, jobId, status: exportStatus.status });

        if (exportStatus.status === 'COMPLETED') {
          break;
        }

        if (exportStatus.status === 'FAILED') {
          throw new Error(exportStatus.error ?? t('exportFailed'));
        }

        await sleep(2000);
      }

      if (!exportStatus || exportStatus.status !== 'COMPLETED') {
        throw new Error(t('exportTimeout'));
      }

      const token = getAccessTokenFromBrowser();
      const headers = new Headers();

      if (token) {
        headers.set('authorization', `Bearer ${token}`);
      }

      headers.set('accept-language', locale.startsWith('sw') ? 'sw' : 'en');

      const downloadResponse = await fetch(`${resolveApiBaseUrl()}/v1/exports/${jobId}/download`, {
        method: 'GET',
        headers,
        credentials: 'include',
        cache: 'no-store',
      });

      if (!downloadResponse.ok) {
        throw new Error(t('exportDownloadFailed'));
      }

      const fallbackFilename = exportStatus.outputFileName ?? `${claimId}-evidence-pack.zip`;
      const filename = parseDownloadFilename(
        downloadResponse.headers.get('content-disposition'),
        fallbackFilename,
      );

      const blob = await downloadResponse.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);

      return { claimId, jobId, filename };
    },
    onSuccess: ({ claimId, jobId }) => {
      setExportNotice(t('exportSuccess', { claimId }));
      setActiveExportJob((previous) => (
        previous && previous.jobId === jobId
          ? { ...previous, status: 'COMPLETED' }
          : previous
      ));
    },
    onError: (error) => {
      const message = error instanceof ApiClientError
        ? error.message
        : error instanceof Error
          ? error.message
          : t('exportFailed');

      setExportNotice(message);
      setActiveExportJob((previous) => (previous ? { ...previous, status: 'FAILED' } : previous));
    },
    onSettled: () => {
      setActiveExportClaimId(null);
    },
  });
  const rows = claimsQuery.data?.data ?? [];
  const meta = (claimsQuery.data?.meta ?? {}) as ClaimsResponseMeta;
  const hasMore = Boolean(meta.hasMore);
  const nextCursorToken = meta.cursor ?? null;

  const batchStatus = batchJobStatusQuery.data?.data;
  const batchIsTerminal = batchStatus?.status === 'COMPLETED' || batchStatus?.status === 'FAILED';

  const columns = useMemo<Array<DataTableColumn<ClaimRow>>>(
    () => [
      {
        key: 'status',
        header: t('table.status'),
        render: (row) => <StatusBadge status={row.status} />,
      },
      {
        key: 'id',
        header: t('table.claimId'),
        render: (row) => (
          <Link href={`/claims/${row.id}`} className="font-semibold text-[var(--accent)]">
            {row.id}
          </Link>
        ),
      },
      {
        key: 'patientShaId',
        header: t('table.patientShaId'),
        render: (row) => row.patientShaId ?? '-',
      },
      {
        key: 'claimType',
        header: t('table.type'),
        render: (row) => {
          try {
            return tClaimTypes(row.claimType);
          } catch {
            return row.claimType;
          }
        },
      },
      {
        key: 'admissionDate',
        header: (
          <SortHeader
            label={t('table.admissionDate')}
            field="admissionDate"
            activeField={sortBy}
            activeOrder={sortOrder}
            onSort={(field) => {
              const order = nextSort(field, sortBy, sortOrder);
              setSortBy(field);
              setSortOrder(order);
              setCursor(null);
              setCursorHistory([]);
            }}
          />
        ),
        render: (row) => formatDate(row.admissionDate, locale),
      },
      {
        key: 'documentCount',
        header: t('table.documents'),
        render: (row) => String(row.documentCount),
      },
      {
        key: 'lastAuditDecision',
        header: t('table.lastDecision'),
        render: (row) => row.lastAuditDecision ?? '-',
      },
      {
        key: 'amountKes',
        header: t('table.amount'),
        render: (row) => formatMoneyKes(row.totalAmount, locale),
      },
      {
        key: 'createdAt',
        header: (
          <SortHeader
            label={t('table.created')}
            field="createdAt"
            activeField={sortBy}
            activeOrder={sortOrder}
            onSort={(field) => {
              const order = nextSort(field, sortBy, sortOrder);
              setSortBy(field);
              setSortOrder(order);
              setCursor(null);
              setCursorHistory([]);
            }}
          />
        ),
        render: (row) => formatDate(row.createdAt, locale),
      },
      {
        key: 'actions',
        header: t('table.actions'),
        render: (row) => (
          <div className="flex flex-wrap gap-2">
            <Link href={`/claims/${row.id}/audit`} className="rounded bg-[var(--accent)] px-2 py-1 text-xs text-white">
              {t('table.audit')}
            </Link>
            <Link href={`/claims/${row.id}`} className="rounded border border-[var(--line)] px-2 py-1 text-xs">
              {t('table.view')}
            </Link>
            <button
              type="button"
              className="rounded border border-[var(--line)] px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => exportClaimMutation.mutate(row.id)}
              disabled={exportClaimMutation.isPending}
              title={t('table.exportHint')}
            >
              {exportClaimMutation.isPending && activeExportClaimId === row.id
                ? t('table.exporting')
                : t('table.export')}
            </button>
          </div>
        ),
      },
    ],
    [activeExportClaimId, exportClaimMutation, locale, sortBy, sortOrder, t, tClaimTypes],
  );

  function handleApplyFilters(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFilters(draftFilters);
    setCursor(null);
    setCursorHistory([]);
  }

  function handleResetFilters(): void {
    setDraftFilters(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
    setCursor(null);
    setCursorHistory([]);
  }

  function handleNextPage(): void {
    if (!nextCursorToken) {
      return;
    }

    setCursorHistory((previous) => [...previous, cursor]);
    setCursor(nextCursorToken);
  }

  function handlePreviousPage(): void {
    setCursorHistory((previous) => {
      if (previous.length === 0) {
        setCursor(null);
        return previous;
      }

      const copy = [...previous];
      const previousCursor = copy.pop() ?? null;
      setCursor(previousCursor);
      return copy;
    });
  }

  const batchMutationError = startBatchAuditMutation.error as ApiClientError | null;
  const batchStatusError = batchJobStatusQuery.error as ApiClientError | null;

  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 py-6">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        breadcrumbs={[{ label: t('dashboardCrumb'), href: '/dashboard' }, { label: t('claimsCrumb') }]}
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => startBatchAuditMutation.mutate()}
              disabled={startBatchAuditMutation.isPending}
              className="rounded-lg border border-[var(--line)] bg-white px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            >
              {startBatchAuditMutation.isPending ? t('queueing') : t('auditAllPending')}
            </button>
            <Link href="/claims/new" className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white">
              {t('newClaim')}
            </Link>
          </div>
        }
      />

      {activeBatchJobId && !showBatchModal ? (
        <div className="glass-card mb-4 flex items-center justify-between gap-3 p-3 text-sm">
          <div>
            {t('batchAuditProgress')} {batchStatus ? `${batchStatus.processedClaims}/${batchStatus.totalClaims}` : ''}{' '}
            {batchStatus ? `(${batchStatus.status})` : `(${t('loading')})`}
          </div>
          <button
            type="button"
            onClick={() => setShowBatchModal(true)}
            className="rounded-lg border border-[var(--line)] px-3 py-1.5"
          >
            {t('openProgress')}
          </button>
        </div>
      ) : null}

      {batchMutationError ? (
        <div className="glass-card mb-4 p-3 text-sm text-[var(--danger)]">
          {batchMutationError.message}
        </div>
      ) : null}


      {activeExportJob ? (
        <div className="glass-card mb-4 p-3 text-sm">
          {t('exportProgress', {
            claimId: activeExportJob.claimId,
            status: activeExportJob.status,
          })}
        </div>
      ) : null}

      {exportNotice ? (
        <div className="glass-card mb-4 p-3 text-sm">
          {exportNotice}
        </div>
      ) : null}
      <form className="glass-card mb-4 grid gap-3 p-4 lg:grid-cols-5" onSubmit={handleApplyFilters}>
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('status')}</span>
          <select
            multiple
            value={draftFilters.statuses}
            onChange={(event) => {
              const selected = Array.from(event.target.selectedOptions).map((option) => option.value as ClaimStatus);
              setDraftFilters((previous) => ({ ...previous, statuses: selected }));
            }}
            className="h-28 w-full rounded-lg border border-[var(--line)] bg-white px-2 py-2 text-sm"
          >
            {STATUS_FILTER_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {(() => {
                  try {
                    return tClaimStatus(status);
                  } catch {
                    return status.replace(/_/g, ' ');
                  }
                })()}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('type')}</span>
          <select
            value={draftFilters.claimType}
            onChange={(event) => setDraftFilters((previous) => ({ ...previous, claimType: event.target.value as ClaimType | '' }))}
            className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
          >
            <option value="">{tCommon('all')}</option>
            {CLAIM_TYPE_OPTIONS.map((claimType) => (
              <option key={claimType} value={claimType}>
                {(() => {
                  try {
                    return tClaimTypes(claimType);
                  } catch {
                    return claimType;
                  }
                })()}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('dateFrom')}</span>
          <input
            type="date"
            value={draftFilters.dateFrom}
            onChange={(event) => setDraftFilters((previous) => ({ ...previous, dateFrom: event.target.value }))}
            className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('dateTo')}</span>
          <input
            type="date"
            value={draftFilters.dateTo}
            onChange={(event) => setDraftFilters((previous) => ({ ...previous, dateTo: event.target.value }))}
            className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{tCommon('search')}</span>
          <input
            type="search"
            value={draftFilters.q}
            onChange={(event) => setDraftFilters((previous) => ({ ...previous, q: event.target.value }))}
            className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
            placeholder={t('searchPlaceholder')}
          />
        </label>

        <div className="lg:col-span-5 flex flex-wrap gap-2">
          <button type="submit" className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white">
            {tCommon('applyFilters')}
          </button>
          <button
            type="button"
            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium"
            onClick={handleResetFilters}
          >
            {tCommon('reset')}
          </button>
          {claimsQuery.isFetching ? <LoadingSpinner size="sm" label={t('refreshing')} /> : null}
        </div>
      </form>

      {claimsQuery.isLoading ? (
        <div className="glass-card p-5">
          <LoadingSpinner label={t('loadingClaims')} />
        </div>
      ) : claimsQuery.isError ? (
        <div className="glass-card p-5 text-sm text-[var(--danger)]">
          {(claimsQuery.error as Error).message}
        </div>
      ) : (
        <DataTable columns={columns} rows={rows} getRowKey={(row) => row.id} />
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--muted)]">{rows.length} {t('claimsLoaded')}</p>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handlePreviousPage}
            disabled={cursorHistory.length === 0 || claimsQuery.isFetching}
          >
            {tCommon('previous')}
          </button>
          <button
            type="button"
            className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleNextPage}
            disabled={!hasMore || !nextCursorToken || claimsQuery.isFetching}
          >
            {tCommon('next')}
          </button>
        </div>
      </div>

      {showBatchModal ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4">
          <div className="glass-card w-full max-w-2xl rounded-xl bg-white p-5">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">{t('batchModal.title')}</h3>
                <p className="text-xs text-[var(--muted)]">{t('batchModal.job')}: {activeBatchJobId}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowBatchModal(false);

                  if (batchIsTerminal) {
                    setActiveBatchJobId(null);
                  }
                }}
                className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
              >
                {batchIsTerminal ? tCommon('close') : tCommon('hide')}
              </button>
            </div>

            {batchJobStatusQuery.isLoading ? (
              <LoadingSpinner label={t('batchModal.loading')} />
            ) : batchStatusError ? (
              <p className="text-sm text-[var(--danger)]">{batchStatusError.message}</p>
            ) : batchStatus ? (
              <div className="space-y-4">
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <div className="rounded-lg border border-[var(--line)] p-3">
                    <p className="text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('batchModal.status')}</p>
                    <p className="mt-1 font-semibold">{batchStatus.status}</p>
                  </div>
                  <div className="rounded-lg border border-[var(--line)] p-3">
                    <p className="text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('batchModal.processed')}</p>
                    <p className="mt-1 font-semibold">
                      {batchStatus.processedClaims} / {batchStatus.totalClaims}
                    </p>
                  </div>
                  <div className="rounded-lg border border-[var(--line)] p-3">
                    <p className="text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('batchModal.decisions')}</p>
                    <p className="mt-1">
                      {t('batchModal.passed')} {batchStatus.passedCount}, {t('batchModal.failed')} {batchStatus.failedCount}, {t('batchModal.warning')} {batchStatus.warningCount}
                    </p>
                  </div>
                  <div className="rounded-lg border border-[var(--line)] p-3">
                    <p className="text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('batchModal.errors')}</p>
                    <p className="mt-1 font-semibold">{batchStatus.errorCount}</p>
                  </div>
                </div>

                <div className="h-2 overflow-hidden rounded-full bg-[var(--line)]">
                  <div
                    className="h-full bg-[var(--accent)] transition-all"
                    style={{
                      width: `${batchStatus.totalClaims > 0 ? (batchStatus.processedClaims / batchStatus.totalClaims) * 100 : 0}%`,
                    }}
                  />
                </div>

                {batchStatus.results.length > 0 ? (
                  <div>
                    <p className="mb-2 text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('batchModal.auditedClaims')}</p>
                    <div className="max-h-36 overflow-y-auto rounded-lg border border-[var(--line)] p-2">
                      <div className="flex flex-wrap gap-2">
                        {batchStatus.results.map((result) => (
                          <Link
                            key={`${result.claimId}-${result.auditSessionId ?? 'none'}`}
                            href={`/claims/${result.claimId}/audit`}
                            className="rounded border border-[var(--line)] px-2 py-1 text-xs hover:border-[var(--accent)] hover:text-[var(--accent)]"
                          >
                            {result.claimId.slice(0, 8)}... ({result.decision ?? t('batchModal.na')})
                          </Link>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}

                {batchStatus.errors.length > 0 ? (
                  <div>
                    <p className="mb-2 text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('batchModal.errors')}</p>
                    <ul className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-[var(--line)] p-2 text-xs">
                      {batchStatus.errors.map((entry, index) => (
                        <li key={`${entry.claimId}-${index}`} className="text-[var(--danger)]">
                          {entry.claimId}: {entry.error}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}




