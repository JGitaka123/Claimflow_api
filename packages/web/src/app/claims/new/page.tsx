'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ClaimType, VisitType, CreateClaimInput } from '@claimflow/shared';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { apiClient } from '@/lib/api-client';

interface ClaimLineDraft {
  id: string;
  shaServiceCode: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

interface FormState {
  facilityId: string;
  claimType: ClaimType;
  visitType: VisitType;
  patientShaId: string;
  patientName: string;
  patientNationalId: string;
  hmisRef: string;
  admissionDate: string;
  dischargeDate: string;
  primaryDiagnosisCode: string;
  shaBenefitPackage: string;
  lines: ClaimLineDraft[];
}

const CLAIM_TYPES: ClaimType[] = [
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

const VISIT_TYPES: VisitType[] = ['OP' as VisitType, 'IP' as VisitType, 'DAYCASE' as VisitType, 'EMERGENCY' as VisitType];

function createLine(): ClaimLineDraft {
  return {
    id: crypto.randomUUID(),
    shaServiceCode: '',
    description: '',
    quantity: 1,
    unitPrice: 0,
  };
}

export default function NewClaimPage(): JSX.Element {
  const t = useTranslations('newClaimPage');
  const tClaimTypes = useTranslations('claims.types');
  const tVisitTypes = useTranslations('claims.visitTypes');
  const router = useRouter();

  const [form, setForm] = useState<FormState>({
    facilityId: '',
    claimType: 'OUTPATIENT' as ClaimType,
    visitType: 'OP' as VisitType,
    patientShaId: '',
    patientName: '',
    patientNationalId: '',
    hmisRef: '',
    admissionDate: '',
    dischargeDate: '',
    primaryDiagnosisCode: '',
    shaBenefitPackage: '',
    lines: [createLine()],
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateLine(index: number, patch: Partial<ClaimLineDraft>): void {
    setForm((previous) => ({
      ...previous,
      lines: previous.lines.map((line, currentIndex) => (currentIndex === index ? { ...line, ...patch } : line)),
    }));
  }

  function addLine(): void {
    setForm((previous) => ({
      ...previous,
      lines: [...previous.lines, createLine()],
    }));
  }

  function removeLine(index: number): void {
    setForm((previous) => {
      if (previous.lines.length <= 1) {
        return previous;
      }

      return {
        ...previous,
        lines: previous.lines.filter((_, currentIndex) => currentIndex !== index),
      };
    });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const payload: CreateClaimInput = {
        facilityId: form.facilityId,
        claimType: form.claimType,
        visitType: form.visitType,
        admissionDate: form.admissionDate,
        dischargeDate: form.dischargeDate || undefined,
        patientShaId: form.patientShaId || undefined,
        patientName: form.patientName || undefined,
        patientNationalId: form.patientNationalId || undefined,
        hmisRef: form.hmisRef || undefined,
        primaryDiagnosisCode: form.primaryDiagnosisCode || undefined,
        shaBenefitPackage: form.shaBenefitPackage || undefined,
        lines: form.lines.map((line) => ({
          shaServiceCode: line.shaServiceCode,
          description: line.description,
          quantity: Number(line.quantity),
          unitPrice: Number(line.unitPrice),
        })),
      };

      const response = await apiClient.post<{ claim: { id: string } }>('/v1/claims', {
        body: payload,
      });

      router.push(`/claims/${response.data.claim.id}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t('createFailed'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        breadcrumbs={[{ label: t('dashboardCrumb'), href: '/dashboard' }, { label: t('claimsCrumb'), href: '/claims' }, { label: t('newCrumb') }]}
        actions={
          <Link href="/claims" className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium">
            {t('backToClaims')}
          </Link>
        }
      />

      <form onSubmit={handleSubmit} className="glass-card space-y-6 p-5">
        <section className="grid gap-4 md:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('facilityId')}</span>
            <input
              required
              value={form.facilityId}
              onChange={(event) => setForm((previous) => ({ ...previous, facilityId: event.target.value }))}
              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              placeholder={t('facilityIdPlaceholder')}
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('claimType')}</span>
            <select
              value={form.claimType}
              onChange={(event) => setForm((previous) => ({ ...previous, claimType: event.target.value as ClaimType }))}
              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
            >
              {CLAIM_TYPES.map((type) => (
                <option key={type} value={type}>
                  {(() => {
                    try {
                      return tClaimTypes(type);
                    } catch {
                      return type;
                    }
                  })()}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('visitType')}</span>
            <select
              value={form.visitType}
              onChange={(event) => setForm((previous) => ({ ...previous, visitType: event.target.value as VisitType }))}
              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
            >
              {VISIT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {(() => {
                    try {
                      return tVisitTypes(type);
                    } catch {
                      return type;
                    }
                  })()}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('patientShaId')}</span>
            <input
              value={form.patientShaId}
              onChange={(event) => setForm((previous) => ({ ...previous, patientShaId: event.target.value }))}
              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('patientName')}</span>
            <input
              value={form.patientName}
              onChange={(event) => setForm((previous) => ({ ...previous, patientName: event.target.value }))}
              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('nationalId')}</span>
            <input
              value={form.patientNationalId}
              onChange={(event) => setForm((previous) => ({ ...previous, patientNationalId: event.target.value }))}
              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('hmisRef')}</span>
            <input
              value={form.hmisRef}
              onChange={(event) => setForm((previous) => ({ ...previous, hmisRef: event.target.value }))}
              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('admissionDate')}</span>
            <input
              required
              type="date"
              value={form.admissionDate}
              onChange={(event) => setForm((previous) => ({ ...previous, admissionDate: event.target.value }))}
              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('dischargeDate')}</span>
            <input
              type="date"
              value={form.dischargeDate}
              onChange={(event) => setForm((previous) => ({ ...previous, dischargeDate: event.target.value }))}
              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('primaryDiagnosisCode')}</span>
            <input
              value={form.primaryDiagnosisCode}
              onChange={(event) => setForm((previous) => ({ ...previous, primaryDiagnosisCode: event.target.value }))}
              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('shaBenefitPackage')}</span>
            <input
              value={form.shaBenefitPackage}
              onChange={(event) => setForm((previous) => ({ ...previous, shaBenefitPackage: event.target.value }))}
              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
            />
          </label>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-[var(--font-heading)] text-lg font-semibold">{t('lineItems')}</h2>
            <button
              type="button"
              className="rounded-lg border border-[var(--line)] px-3 py-1 text-sm"
              onClick={addLine}
            >
              {t('addLine')}
            </button>
          </div>

          <div className="space-y-3">
            {form.lines.map((line, index) => (
              <article key={line.id} className="rounded-xl border border-[var(--line)] bg-white/70 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium">{t('line')} #{index + 1}</p>
                  <button
                    type="button"
                    className="text-xs text-[var(--danger)]"
                    onClick={() => removeLine(index)}
                    disabled={form.lines.length <= 1}
                  >
                    {t('remove')}
                  </button>
                </div>

                <div className="grid gap-3 md:grid-cols-4">
                  <label className="text-sm">
                    <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('serviceCode')}</span>
                    <input
                      required
                      value={line.shaServiceCode}
                      onChange={(event) => updateLine(index, { shaServiceCode: event.target.value })}
                      className="w-full rounded-lg border border-[var(--line)] px-3 py-2"
                    />
                  </label>
                  <label className="text-sm md:col-span-2">
                    <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('description')}</span>
                    <input
                      required
                      value={line.description}
                      onChange={(event) => updateLine(index, { description: event.target.value })}
                      className="w-full rounded-lg border border-[var(--line)] px-3 py-2"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('quantity')}</span>
                    <input
                      required
                      type="number"
                      min={1}
                      value={line.quantity}
                      onChange={(event) => updateLine(index, { quantity: Number(event.target.value) })}
                      className="w-full rounded-lg border border-[var(--line)] px-3 py-2"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('unitPrice')}</span>
                    <input
                      required
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.unitPrice}
                      onChange={(event) => updateLine(index, { unitPrice: Number(event.target.value) })}
                      className="w-full rounded-lg border border-[var(--line)] px-3 py-2"
                    />
                  </label>
                </div>
              </article>
            ))}
          </div>
        </section>

        {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
            disabled={isSubmitting}
          >
            {isSubmitting ? <LoadingSpinner label={t('creatingClaim')} size="sm" /> : t('createClaim')}
          </button>
        </div>
      </form>
    </main>
  );
}