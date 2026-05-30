'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: Array<DataTableColumn<T>>;
  rows: T[];
  getRowKey: (row: T) => string;
  emptyMessage?: string;
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  emptyMessage,
}: DataTableProps<T>): JSX.Element {
  const t = useTranslations('common');
  const resolvedEmptyMessage = emptyMessage ?? t('empty');

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-card">
      <table className="w-full border-collapse text-left">
        <thead className="bg-[var(--soft)] text-xs uppercase tracking-[0.07em] text-[var(--muted)]">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className="px-4 py-3 font-semibold">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={columns.length}>
                {resolvedEmptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={getRowKey(row)} className="border-t border-[var(--line)] text-sm text-[var(--ink)]">
                {columns.map((column) => (
                  <td key={column.key} className="px-4 py-3 align-top">
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}