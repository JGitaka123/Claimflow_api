import Link from 'next/link';
import type { ReactNode } from 'react';

interface Breadcrumb {
  href?: string;
  label: string;
}

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  breadcrumbs?: Breadcrumb[];
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, breadcrumbs = [], actions }: PageHeaderProps): JSX.Element {
  return (
    <header className="mb-6 rounded-2xl border border-[var(--line)] bg-[var(--soft)]/90 p-5 shadow-card">
      {breadcrumbs.length > 0 ? (
        <nav className="mb-3 flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.08em] text-[var(--muted)]">
          {breadcrumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="inline-flex items-center gap-2">
              {crumb.href ? <Link href={crumb.href}>{crumb.label}</Link> : <span>{crumb.label}</span>}
              {index < breadcrumbs.length - 1 ? <span>/</span> : null}
            </span>
          ))}
        </nav>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-[var(--font-heading)] text-2xl font-bold text-[var(--ink)]">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm text-[var(--muted)]">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
