'use client';

import { useTranslations } from 'next-intl';

interface LoadingSpinnerProps {
  label?: string;
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_CLASS_MAP = {
  sm: 'h-4 w-4 border-2',
  md: 'h-6 w-6 border-2',
  lg: 'h-8 w-8 border-[3px]',
} as const;

export function LoadingSpinner({ label, size = 'md' }: LoadingSpinnerProps): JSX.Element {
  const t = useTranslations('common');
  const resolvedLabel = label ?? t('loading');

  return (
    <span className="inline-flex items-center gap-2 text-sm text-[var(--muted)]">
      <span
        className={`${SIZE_CLASS_MAP[size]} inline-block animate-spin rounded-full border-[var(--line)] border-t-[var(--accent)]`}
        aria-hidden="true"
      />
      <span>{resolvedLabel}</span>
    </span>
  );
}