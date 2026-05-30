'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/contexts/auth-context';

interface DashboardOverviewResponse {
  claimsToday: number;
  claimsThisWeek: number;
  passRate: number;
  pendingAudit: number;
  avgAuditTimeSec: number;
  mlStatus: string;
  mlLatencyMs: number | null;
  queueDepth: number;
  avgOcrConfidence: number;
  claimsByStatus: Array<{ status: string; count: number }>;
  trend: Array<{ date: string; passed: number; failed: number; warning: number }>;
  claimsByType: Array<{ type: string; count: number }>;
  documentProcessing: {
    totalDocs: number;
    completedDocs: number;
    failedDocs: number;
  };
}

interface TopFailureItem {
  ruleId: string;
  failures: number;
  affectedClaims: number;
  previousFailures: number;
  trendPercent: number;
}

interface TopFailuresResponse {
  period: string;
  items: TopFailureItem[];
}

interface OfficerProductivityItem {
  userId: string;
  displayName: string;
  role: string;
  claimsAudited: number;
  avgAuditTimeSec: number;
  correctionsCount: number;
}

interface OfficerProductivityResponse {
  period: string;
  items: OfficerProductivityItem[];
}

interface DocumentQualityItem {
  docType: string;
  documentsCount: number;
  avgOcrConfidence: number;
  manualEntryRate: number;
}

interface DocumentQualityResponse {
  period: string;
  items: DocumentQualityItem[];
}

const PIE_COLORS = ['#0f766e', '#f59e0b', '#ef4444', '#2563eb', '#9333ea', '#16a34a', '#0ea5e9'];

function formatDateLabel(value: string, locale: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString(locale, {
    month: 'short',
    day: '2-digit',
  });
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatDuration(valueSeconds: number): string {
  return `${valueSeconds.toFixed(1)}s`;
}

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

function formatConfidence(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function mlStatusClassName(status: string): string {
  return status === 'HEALTHY' ? 'text-emerald-700' : 'text-red-700';
}

function roleLabel(role: string): string {
  return role.replace(/_/g, ' ').replace(/\b\w/g, (value) => value.toUpperCase());
}

function claimTypeLabel(value: string, tClaimsType: ReturnType<typeof useTranslations>): string {
  try {
    return tClaimsType(value);
  } catch {
    return value;
  }
}

export default function DashboardPage(): JSX.Element {
  const t = useTranslations('dashboardPage');
  const tClaimsType = useTranslations('claims.types');
  const locale = useLocale().startsWith('sw') ? 'sw-KE' : 'en-KE';
  const { user } = useAuth();

  const normalizedRole = (user?.role ?? '').toLowerCase();
  const isAdmin = normalizedRole === 'admin' || normalizedRole === 'super_admin';

  const overviewQuery = useQuery({
    queryKey: ['dashboard-overview'],
    queryFn: async () => {
      const response = await apiClient.get<DashboardOverviewResponse>('/v1/dashboard/overview');
      return response.data;
    },
    refetchInterval: 60_000,
  });

  const topFailuresQuery = useQuery({
    queryKey: ['dashboard-top-failures'],
    queryFn: async () => {
      const response = await apiClient.get<TopFailuresResponse>('/v1/dashboard/rules/top-failures?period=30d&limit=10');
      return response.data;
    },
    refetchInterval: 60_000,
  });

  const documentQualityQuery = useQuery({
    queryKey: ['dashboard-document-quality'],
    queryFn: async () => {
      const response = await apiClient.get<DocumentQualityResponse>('/v1/dashboard/document-quality?period=30d');
      return response.data;
    },
    refetchInterval: 60_000,
  });

  const officerProductivityQuery = useQuery({
    queryKey: ['dashboard-officer-productivity'],
    enabled: isAdmin,
    queryFn: async () => {
      const response = await apiClient.get<OfficerProductivityResponse>('/v1/dashboard/officer-productivity?period=30d');
      return response.data;
    },
    refetchInterval: 60_000,
  });

  const isLoading = overviewQuery.isLoading || topFailuresQuery.isLoading || documentQualityQuery.isLoading;
  const hasPrimaryError = overviewQuery.isError || topFailuresQuery.isError || documentQualityQuery.isError;

  const overview = overviewQuery.data;
  const topFailures = topFailuresQuery.data?.items ?? [];
  const documentQuality = documentQualityQuery.data?.items ?? [];
  const officerProductivity = officerProductivityQuery.data?.items ?? [];

  const summaryCards = useMemo(() => {
    if (!overview) {
      return [];
    }

    const mlLatencyText = overview.mlLatencyMs === null ? t('na') : `${Math.round(overview.mlLatencyMs)}ms`;

    return [
      { label: t('claimsToday'), value: formatNumber(overview.claimsToday, locale) },
      { label: t('claimsThisWeek'), value: formatNumber(overview.claimsThisWeek, locale) },
      { label: t('passRate'), value: formatPercent(overview.passRate) },
      { label: t('pendingAudit'), value: formatNumber(overview.pendingAudit, locale) },
      { label: t('avgAuditTime'), value: formatDuration(overview.avgAuditTimeSec) },
      { label: t('mlStatus'), value: `${overview.mlStatus} (${mlLatencyText})` },
      { label: t('queueDepth'), value: formatNumber(overview.queueDepth, locale) },
      { label: t('avgOcrConfidence'), value: formatConfidence(overview.avgOcrConfidence) },
    ];
  }, [locale, overview, t]);

  const documentQualityChartData = useMemo(
    () =>
      documentQuality.map((item) => ({
        docType: item.docType,
        documents: item.documentsCount,
        avgOcrConfidencePct: Number((item.avgOcrConfidence * 100).toFixed(2)),
        manualEntryRatePct: Number((item.manualEntryRate * 100).toFixed(2)),
      })),
    [documentQuality],
  );

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        breadcrumbs={[{ label: t('breadcrumb') }]}
        actions={
          <Link href="/claims" className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white">
            {t('openClaims')}
          </Link>
        }
      />

      {isLoading ? (
        <div className="glass-card mb-4 p-4">
          <LoadingSpinner label={t('loading')} />
        </div>
      ) : null}

      {hasPrimaryError ? (
        <div className="glass-card mb-4 border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {(overviewQuery.error as Error | undefined)?.message ??
            (topFailuresQuery.error as Error | undefined)?.message ??
            (documentQualityQuery.error as Error | undefined)?.message ??
            t('loadFailed')}
        </div>
      ) : null}

      {overview ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {summaryCards.map((metric) => (
              <article key={metric.label} className="glass-card p-4">
                <p className="text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{metric.label}</p>
                <p className={clsx('mt-2 font-[var(--font-heading)] text-2xl font-semibold', metric.label === t('mlStatus') ? mlStatusClassName(overview.mlStatus) : '')}>
                  {metric.value}
                </p>
              </article>
            ))}
          </section>

          <section className="mt-5 grid gap-4 lg:grid-cols-2">
            <article className="glass-card p-4">
              <h2 className="mb-3 font-[var(--font-heading)] text-lg font-semibold">{t('trendTitle')}</h2>
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={overview.trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ddd5c8" />
                    <XAxis dataKey="date" tickFormatter={(value) => formatDateLabel(value, locale)} stroke="#5a6479" />
                    <YAxis stroke="#5a6479" />
                    <Tooltip labelFormatter={(value) => formatDateLabel(String(value), locale)} />
                    <Legend />
                    <Line type="monotone" dataKey="passed" name={t('passed')} stroke="#15803d" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="failed" name={t('failed')} stroke="#dc2626" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="warning" name={t('warning')} stroke="#f59e0b" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="glass-card p-4">
              <h2 className="mb-3 font-[var(--font-heading)] text-lg font-semibold">{t('claimsByType')}</h2>
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={overview.claimsByType.map((row) => ({ ...row, typeLabel: claimTypeLabel(row.type, tClaimsType) }))}
                      dataKey="count"
                      nameKey="typeLabel"
                      innerRadius={55}
                      outerRadius={95}
                      paddingAngle={2}
                    >
                      {overview.claimsByType.map((entry, index) => (
                        <Cell key={entry.type} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </article>
          </section>

          <section className="mt-5 grid gap-4 lg:grid-cols-2">
            <article className="glass-card p-4">
              <h2 className="mb-3 font-[var(--font-heading)] text-lg font-semibold">{t('topFailingRules')}</h2>
              <div className="h-[320px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topFailures} layout="vertical" margin={{ left: 20, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ddd5c8" />
                    <XAxis type="number" stroke="#5a6479" />
                    <YAxis dataKey="ruleId" type="category" width={80} stroke="#5a6479" />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="failures" name={t('failures')} fill="#dc2626" />
                    <Bar dataKey="affectedClaims" name={t('affectedClaims')} fill="#0f766e" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 space-y-1 text-xs text-[var(--muted)]">
                {topFailures.slice(0, 5).map((item) => (
                  <p key={`${item.ruleId}-trend`}>
                    {item.ruleId}: {item.trendPercent >= 0 ? '+' : ''}
                    {item.trendPercent.toFixed(1)}% {t('trendVsPrevious')}
                  </p>
                ))}
              </div>
            </article>

            <article className="glass-card p-4">
              <h2 className="mb-3 font-[var(--font-heading)] text-lg font-semibold">{t('documentQuality')}</h2>
              <div className="h-[320px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={documentQualityChartData} margin={{ left: 0, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ddd5c8" />
                    <XAxis dataKey="docType" interval={0} angle={-25} textAnchor="end" height={95} stroke="#5a6479" />
                    <YAxis stroke="#5a6479" />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="avgOcrConfidencePct" name={t('avgOcrConfidencePct')} fill="#2563eb" />
                    <Bar dataKey="manualEntryRatePct" name={t('manualEntryPct')} fill="#f59e0b" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>
          </section>

          <section className="mt-5 grid gap-4 lg:grid-cols-[2fr_1fr]">
            <article className="glass-card p-4">
              <h2 className="mb-3 font-[var(--font-heading)] text-lg font-semibold">{t('claimsByStatus')}</h2>
              <div className="flex flex-wrap gap-2">
                {overview.claimsByStatus.map((statusRow) => (
                  <span key={statusRow.status} className="rounded-full border border-[var(--line)] bg-white px-3 py-1 text-xs">
                    {statusRow.status.replace(/_/g, ' ')}: {formatNumber(statusRow.count, locale)}
                  </span>
                ))}
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                <div className="rounded-lg border border-[var(--line)] bg-white p-3 text-sm">
                  <p className="text-xs text-[var(--muted)]">{t('documentsMonth')}</p>
                  <p className="mt-1 font-semibold">{formatNumber(overview.documentProcessing.totalDocs, locale)}</p>
                </div>
                <div className="rounded-lg border border-[var(--line)] bg-white p-3 text-sm">
                  <p className="text-xs text-[var(--muted)]">{t('completed')}</p>
                  <p className="mt-1 font-semibold text-emerald-700">{formatNumber(overview.documentProcessing.completedDocs, locale)}</p>
                </div>
                <div className="rounded-lg border border-[var(--line)] bg-white p-3 text-sm">
                  <p className="text-xs text-[var(--muted)]">{t('failed')}</p>
                  <p className="mt-1 font-semibold text-red-700">{formatNumber(overview.documentProcessing.failedDocs, locale)}</p>
                </div>
              </div>
            </article>

            <article className="glass-card p-4">
              <h2 className="mb-3 font-[var(--font-heading)] text-lg font-semibold">{t('officerProductivity')}</h2>
              {!isAdmin ? (
                <p className="text-sm text-[var(--muted)]">{t('restricted')}</p>
              ) : officerProductivityQuery.isLoading ? (
                <LoadingSpinner size="sm" label={t('loadingOfficer')} />
              ) : officerProductivityQuery.isError ? (
                <p className="text-sm text-red-700">{(officerProductivityQuery.error as Error).message}</p>
              ) : officerProductivity.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">{t('noProductivity')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-xs">
                    <thead>
                      <tr className="border-b border-[var(--line)] text-[var(--muted)]">
                        <th className="px-2 py-2">{t('officer')}</th>
                        <th className="px-2 py-2">{t('role')}</th>
                        <th className="px-2 py-2">{t('claims')}</th>
                        <th className="px-2 py-2">{t('avgTime')}</th>
                        <th className="px-2 py-2">{t('corrections')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {officerProductivity.map((row) => (
                        <tr key={row.userId} className="border-b border-[var(--line)]/60">
                          <td className="px-2 py-2 font-medium">{row.displayName}</td>
                          <td className="px-2 py-2">{roleLabel(row.role)}</td>
                          <td className="px-2 py-2">{formatNumber(row.claimsAudited, locale)}</td>
                          <td className="px-2 py-2">{formatDuration(row.avgAuditTimeSec)}</td>
                          <td className="px-2 py-2">{formatNumber(row.correctionsCount, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </article>
          </section>
        </>
      ) : null}
    </main>
  );
}