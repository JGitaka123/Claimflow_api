'use client';

import clsx from 'clsx';
import { useTranslations } from 'next-intl';

const STATUS_CLASS_MAP: Record<string, string> = {
  DRAFT: 'bg-slate-200 text-slate-800',
  DOCUMENTS_UPLOADED: 'bg-sky-100 text-sky-800',
  PROCESSING: 'bg-amber-100 text-amber-800',
  AUDIT_COMPLETE: 'bg-violet-100 text-violet-800',
  PASSED: 'bg-emerald-100 text-emerald-800',
  WARNING: 'bg-orange-100 text-orange-800',
  FAILED: 'bg-red-100 text-red-800',
  CORRECTIONS_IN_PROGRESS: 'bg-yellow-100 text-yellow-800',
  OVERRIDE_PENDING: 'bg-pink-100 text-pink-800',
  OVERRIDE_APPROVED: 'bg-teal-100 text-teal-800',
};

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps): JSX.Element {
  const t = useTranslations('claims.status');
  const normalized = status.toUpperCase();

  let label = normalized.replace(/_/g, ' ');

  try {
    label = t(normalized);
  } catch {
    // Fallback to normalized status when translation key is not present.
  }

  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold tracking-wide',
        STATUS_CLASS_MAP[normalized] ?? 'bg-gray-100 text-gray-700',
        className,
      )}
    >
      {label}
    </span>
  );
}