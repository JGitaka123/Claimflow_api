'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { Claim } from '@claimflow/shared';
import { ApiClientError, apiClient } from '@/lib/api-client';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';

type ClaimDetailPayload = {
  claim: Claim;
};

type ClaimDocument = {
  id: string;
  docType: string;
  processingStatus: string;
  originalFilename: string;
  pageCount: number;
  uploadedAt: string;
};

const DOCUMENT_TYPES = [
  'SHA_CLAIM_FORM_OP',
  'SHA_CLAIM_FORM_IP',
  'SHA_CLAIM_FORM_MATERNITY',
  'PREAUTH_FORM',
  'DISCHARGE_SUMMARY',
  'PHYSICIAN_NOTES',
  'LAB_RESULTS',
  'PRESCRIPTION',
  'REFERRAL_LETTER',
  'RADIOLOGY_REPORT',
  'OPERATIVE_NOTE',
  'NATIONAL_ID_COPY',
  'SHA_CARD_COPY',
  'CONSENT_FORM',
  'OTHER_SUPPORTING',
] as const;

function formatDate(value: string | null): string {
  if (!value) {
    return '-';
  }

  if (value.length >= 10) {
    return value.slice(0, 10);
  }

  return value;
}

function formatDateTime(value: string): string {
  const normalized = value.replace('T', ' ');
  return normalized.length >= 16 ? normalized.slice(0, 16) : normalized;
}

function enumLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

export default function ClaimDetailPage(): JSX.Element {
  const t = useTranslations('claimDetailPage');
  const tCommon = useTranslations('common');
  const tClaimTypes = useTranslations('claims.types');
  const { id } = useParams<{ id: string }>();
  const claimId = id ?? '';

  const [docType, setDocType] = useState<string>('SHA_CLAIM_FORM_OP');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const claimQuery = useQuery({
    queryKey: ['claim-detail', claimId],
    enabled: claimId.length > 0,
    queryFn: async () => (await apiClient.get<ClaimDetailPayload>(`/v1/claims/${claimId}`)).data,
  });

  const documentsQuery = useQuery({
    queryKey: ['claim-documents', claimId],
    enabled: claimId.length > 0,
    queryFn: async () => (await apiClient.get<ClaimDocument[]>(`/v1/claims/${claimId}/documents`)).data,
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile) {
        throw new Error(t('selectFileRequired'));
      }

      const formData = new FormData();
      formData.append('docType', docType);
      formData.append('file', selectedFile, selectedFile.name);

      await apiClient.post(`/v1/claims/${claimId}/documents`, {
        body: formData,
      });
    },
    onSuccess: async () => {
      setSelectedFile(null);
      setFeedback({ tone: 'success', message: t('uploadSuccess') });
      await Promise.all([claimQuery.refetch(), documentsQuery.refetch()]);
    },
    onError: (error) => {
      if (error instanceof ApiClientError || error instanceof Error) {
        setFeedback({ tone: 'error', message: error.message });
        return;
      }

      setFeedback({ tone: 'error', message: t('uploadFailed') });
    },
  });

  const claim = claimQuery.data?.claim;
  const documents = documentsQuery.data ?? [];

  const lineItems = useMemo(() => claim?.lines ?? [], [claim?.lines]);

  if (claimQuery.isLoading || documentsQuery.isLoading) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        <div className="glass-card p-5">
          <LoadingSpinner label={tCommon('loading')} />
        </div>
      </main>
    );
  }

  if (!claim) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        <div className="glass-card p-5 text-sm text-[var(--danger)]">{t('claimNotFound')}</div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6">
      <PageHeader
        title={t('title', { id: claimId })}
        subtitle={t('subtitle')}
        breadcrumbs={[{ label: t('dashboardCrumb'), href: '/dashboard' }, { label: t('claimsCrumb'), href: '/claims' }, { label: claimId }]}
        actions={
          <Link href={`/claims/${claimId}/audit`} className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white">
            {t('openAudit')}
          </Link>
        }
      />

      <section className="glass-card mb-4 p-5">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{tCommon('status')}</dt>
            <dd className="mt-1"><StatusBadge status={claim.status} /></dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('patientShaId')}</dt>
            <dd className="mt-1 text-sm">{claim.patientShaId ?? '-'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('claimType')}</dt>
            <dd className="mt-1 text-sm">{(() => {
              try {
                return tClaimTypes(claim.claimType);
              } catch {
                return claim.claimType;
              }
            })()}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('admissionDate')}</dt>
            <dd className="mt-1 text-sm">{formatDate(claim.admissionDate)}</dd>
          </div>
        </dl>
      </section>

      <section className="glass-card mb-4 p-5">
        <h2 className="font-[var(--font-heading)] text-lg font-semibold">{t('uploadTitle')}</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">{t('uploadSubtitle')}</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,220px)_1fr_auto] sm:items-end">
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('documentType')}</span>
            <select
              aria-label={t('documentType')}
              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              value={docType}
              onChange={(event) => setDocType(event.target.value)}
            >
              {DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>{enumLabel(type)}</option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('file')}</span>
            <input
              aria-label={t('file')}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/tiff"
              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
            />
          </label>

          <button
            type="button"
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => uploadMutation.mutate()}
            disabled={uploadMutation.isPending}
          >
            {uploadMutation.isPending ? t('uploading') : t('upload')}
          </button>
        </div>

        {feedback ? (
          <p className={feedback.tone === 'error' ? 'mt-3 text-sm text-[var(--danger)]' : 'mt-3 text-sm text-emerald-700'}>
            {feedback.message}
          </p>
        ) : null}
      </section>

      <section className="glass-card mb-4 p-5">
        <h2 className="font-[var(--font-heading)] text-lg font-semibold">{t('documentsTitle')}</h2>

        {documents.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--muted)]">{t('noDocuments')}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-[0.08em] text-[var(--muted)]">
                  <th className="py-2 pr-3">{t('docType')}</th>
                  <th className="py-2 pr-3">{t('filename')}</th>
                  <th className="py-2 pr-3">{t('pages')}</th>
                  <th className="py-2 pr-3">{t('processingStatus')}</th>
                  <th className="py-2 pr-3">{t('uploadedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id} className="border-b border-[var(--line)] last:border-b-0">
                    <td className="py-2 pr-3">{enumLabel(document.docType)}</td>
                    <td className="py-2 pr-3">{document.originalFilename}</td>
                    <td className="py-2 pr-3">{document.pageCount}</td>
                    <td className="py-2 pr-3">{enumLabel(document.processingStatus)}</td>
                    <td className="py-2 pr-3">{formatDateTime(document.uploadedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="glass-card p-5">
        <h2 className="font-[var(--font-heading)] text-lg font-semibold">{t('lineItemsTitle')}</h2>

        {lineItems.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--muted)]">{t('noLineItems')}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-[0.08em] text-[var(--muted)]">
                  <th className="py-2 pr-3">{t('line')}</th>
                  <th className="py-2 pr-3">{t('serviceCode')}</th>
                  <th className="py-2 pr-3">{t('description')}</th>
                  <th className="py-2 pr-3">{t('quantity')}</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((line) => (
                  <tr key={line.id} className="border-b border-[var(--line)] last:border-b-0">
                    <td className="py-2 pr-3">{line.lineNumber}</td>
                    <td className="py-2 pr-3">{line.shaServiceCode}</td>
                    <td className="py-2 pr-3">{line.description}</td>
                    <td className="py-2 pr-3">{line.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

