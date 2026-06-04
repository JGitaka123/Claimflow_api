'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useTranslations } from 'next-intl';
import type { Claim } from '@claimflow/shared';
import { ApiClientError, apiClient } from '@/lib/api-client';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

type DocumentItem = {
  id: string;
  docType: string;
  mimeType: string;
  originalFilename: string;
  pageCount: number;
};

type PageRef = {
  key: string;
  docId: string;
  pageNumber: number;
  docType: string;
  mimeType: string;
  originalFilename: string;
  docOrdinal: number;
};

type Field = {
  id: string;
  fieldKey: string;
  value: string | null;
  confidence: number;
  confidenceTier: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
  source: string;
};

type Extraction = {
  documentId: string;
  pageNumber: number;
  ocr: { confidence: number | null; rawText: string | null };
  fields: Field[];
};

// Shape of GET /v1/claims/:id/audit/latest (the public-safe AuditSummary). It
// carries per-finding message / remediation / evidence the dashboard needs, but
// never the three system internals (deterministic/ML scores, fix report).
type AuditResult = {
  rulepackVersion: string;
  decision: string | null;
  failedCount: number;
  warningCount: number;
  incompleteCount: number;
  findings: Array<{
    ruleId: string;
    result: string;
    message: string;
    remediation: string | null;
    evidence: Record<string, unknown> | null;
  }>;
};

type ClaimDetail = {
  claim: Claim;
};

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
function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:8080';
}

function getToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const stored = window.localStorage.getItem('cf_access_token');
  if (stored) {
    return stored;
  }

  const cookie = document.cookie
    .split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith('cf_access_token='));

  return cookie ? decodeURIComponent(cookie.split('=').slice(1).join('=')) : null;
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

function renderSafeMarkdown(markdown: string): string {
  const parsed = marked.parse(markdown, {
    gfm: true,
    breaks: true,
  });

  const html = typeof parsed === 'string' ? parsed : String(parsed);
  return DOMPurify.sanitize(html, {
    USE_PROFILES: {
      html: true,
    },
  });
}

function fieldLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function tierUi(tier: string): { icon: string; chip: string; card: string } {
  const normalized = tier.toUpperCase();

  if (normalized === 'HIGH') {
    return { icon: '\\u2705', chip: 'bg-emerald-100 text-emerald-800', card: 'border-emerald-200 bg-emerald-50/50' };
  }

  if (normalized === 'MEDIUM') {
    return { icon: '\\u26A0\\uFE0F', chip: 'bg-amber-100 text-amber-800', card: 'border-amber-200 bg-amber-50/70' };
  }

  return { icon: '\\uD83D\\uDD34', chip: 'bg-red-100 text-red-800', card: 'border-red-200 bg-red-50/70' };
}

function bboxStyle(bbox: { x: number; y: number; w: number; h: number }): React.CSSProperties {
  const isNorm = bbox.x <= 1 && bbox.y <= 1 && bbox.w <= 1 && bbox.h <= 1;

  if (isNorm) {
    return {
      left: `${bbox.x * 100}%`,
      top: `${bbox.y * 100}%`,
      width: `${bbox.w * 100}%`,
      height: `${bbox.h * 100}%`,
    };
  }

  return {
    left: `${bbox.x}px`,
    top: `${bbox.y}px`,
    width: `${bbox.w}px`,
    height: `${bbox.h}px`,
  };
}

export default function AuditWorkspacePage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const claimId = id ?? '';
  const queryClient = useQueryClient();
  const tAudit = useTranslations('auditPage');

  const [activePageIndex, setActivePageIndex] = useState(0);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [undoStack, setUndoStack] = useState<Array<{ fieldId: string; from: string; to: string; base: string }>>([]);
  const [redoStack, setRedoStack] = useState<Array<{ fieldId: string; from: string; to: string; base: string }>>([]);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveText, setSaveText] = useState<string | null>(null);
  const [fixCollapsed, setFixCollapsed] = useState(false);
  const [blobUrls, setBlobUrls] = useState<Record<string, string>>({});
  const [blobError, setBlobError] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, Extraction>>({});
  const [activeExportJob, setActiveExportJob] = useState<{ jobId: string; status: ExportJobStatus['status'] } | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const fieldRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const blobRef = useRef<Record<string, string>>({});
  const saveTimer = useRef<number | null>(null);

  const claimQuery = useQuery({
    queryKey: ['claim-detail', claimId],
    enabled: claimId.length > 0,
    queryFn: async () => (await apiClient.get<ClaimDetail>(`/v1/claims/${claimId}`)).data,
  });

  const docsQuery = useQuery({
    queryKey: ['claim-docs', claimId],
    enabled: claimId.length > 0,
    queryFn: async () => (await apiClient.get<DocumentItem[]>(`/v1/claims/${claimId}/documents`)).data,
  });

  const auditQuery = useQuery({
    queryKey: ['claim-audit-latest', claimId],
    enabled: claimId.length > 0,
    retry: false,
    queryFn: async () => {
      try {
        return (await apiClient.get<AuditResult>(`/v1/claims/${claimId}/audit/latest`)).data;
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
  });

  const pages = useMemo<PageRef[]>(() => {
    const docs = docsQuery.data ?? [];

    return docs.flatMap((doc, docIndex) =>
      Array.from({ length: doc.pageCount }, (_, i) => ({
        key: `${doc.id}:${i + 1}`,
        docId: doc.id,
        pageNumber: i + 1,
        docType: doc.docType,
        mimeType: doc.mimeType,
        originalFilename: doc.originalFilename,
        docOrdinal: docIndex + 1,
      })),
    );
  }, [docsQuery.data]);

  const page = pages[activePageIndex] ?? null;

  const extractionQuery = useQuery({
    queryKey: ['extraction', page?.docId, page?.pageNumber],
    enabled: Boolean(page),
    retry: false,
    queryFn: async () => {
      if (!page) {
        throw new Error('No active page');
      }

      try {
        return (await apiClient.get<Extraction>(`/v1/documents/${page.docId}/pages/${page.pageNumber}/extraction`)).data;
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 404) {
          return {
            documentId: page.docId,
            pageNumber: page.pageNumber,
            ocr: { confidence: null, rawText: null },
            fields: [],
          } as Extraction;
        }

        throw error;
      }
    },
  });

  const currentExtraction = useMemo(() => {
    if (!page) {
      return null;
    }

    return extractionQuery.data ?? cache[page.key] ?? null;
  }, [cache, extractionQuery.data, page]);

  useEffect(() => {
    if (!page || !extractionQuery.data) {
      return;
    }

    setCache((prev) => ({ ...prev, [page.key]: extractionQuery.data }));
  }, [extractionQuery.data, page]);

  useEffect(() => {
    if (activePageIndex > Math.max(0, pages.length - 1)) {
      setActivePageIndex(Math.max(0, pages.length - 1));
    }
  }, [activePageIndex, pages.length]);

  useEffect(() => {
    blobRef.current = blobUrls;
  }, [blobUrls]);

  useEffect(() => {
    return () => {
      Object.values(blobRef.current).forEach((url) => URL.revokeObjectURL(url));
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!page || blobUrls[page.docId]) {
      return;
    }

    const ctrl = new AbortController();

    void (async () => {
      try {
        const headers = new Headers();
        const token = getToken();
        if (token) {
          headers.set('authorization', `Bearer ${token}`);
        }

        const res = await fetch(`${getApiBaseUrl()}/v1/documents/${page.docId}/download`, {
          headers,
          credentials: 'include',
          cache: 'no-store',
          signal: ctrl.signal,
        });

        if (!res.ok) {
          throw new Error(`Preview request failed (${res.status})`);
        }

        const url = URL.createObjectURL(await res.blob());
        setBlobUrls((prev) => ({ ...prev, [page.docId]: url }));
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }

        setBlobError(error instanceof Error ? error.message : 'Preview unavailable');
      }
    })();

    return () => ctrl.abort();
  }, [blobUrls, page]);

  const fields = currentExtraction?.fields ?? [];

  useEffect(() => {
    if (fields.length === 0) {
      setSelectedFieldId(null);
      return;
    }

    if (selectedFieldId && fields.some((f) => f.id === selectedFieldId)) {
      return;
    }

    const firstReview = fields.find((f) => ['LOW', 'MEDIUM'].includes(f.confidenceTier.toUpperCase()));
    setSelectedFieldId(firstReview?.id ?? fields[0]?.id ?? null);
  }, [fields, selectedFieldId]);

  const setFeedback = useCallback((state: SaveState, message: string | null) => {
    setSaveState(state);
    setSaveText(message);

    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    if (state === 'saved') {
      saveTimer.current = window.setTimeout(() => {
        setSaveState('idle');
        setSaveText(null);
      }, 1800);
    }
  }, []);

  const locations = useMemo(() => {
    const map = new Map<string, { pageKey: string; docId: string; pageNumber: number; fieldKey: string }>();

    for (const [pageKey, extraction] of Object.entries(cache)) {
      const [docId, pageRaw] = pageKey.split(':');
      const pageNumber = Number(pageRaw);
      if (!docId || !Number.isInteger(pageNumber)) {
        continue;
      }

      extraction.fields.forEach((f) => {
        map.set(f.id, { pageKey, docId, pageNumber, fieldKey: f.fieldKey });
      });
    }

    if (page && currentExtraction) {
      currentExtraction.fields.forEach((f) => {
        map.set(f.id, { pageKey: page.key, docId: page.docId, pageNumber: page.pageNumber, fieldKey: f.fieldKey });
      });
    }

    return map;
  }, [cache, currentExtraction, page]);

  const savePending = useCallback(
    async (ids?: string[]) => {
      const target = (ids ?? Object.keys(pending)).filter((fieldId) => pending[fieldId] !== undefined);

      if (target.length === 0) {
        setFeedback('saved', 'Saved ?');
        return;
      }

      setFeedback('saving', 'Saving...');

      try {
        for (const fieldId of target) {
          const correctedValue = pending[fieldId];
          if (correctedValue === undefined) {
            continue;
          }

          await apiClient.post(`/v1/extracted-fields/${fieldId}/correct`, {
            body: { correctedValue },
          });

          const loc = locations.get(fieldId);
          if (!loc) {
            continue;
          }

          setCache((prev) => {
            const item = prev[loc.pageKey];
            if (!item) {
              return prev;
            }

            return {
              ...prev,
              [loc.pageKey]: {
                ...item,
                fields: item.fields.map((f) =>
                  f.id === fieldId ? { ...f, value: correctedValue, source: 'MANUAL' } : f,
                ),
              },
            };
          });

          queryClient.setQueryData<Extraction | undefined>(
            ['extraction', loc.docId, loc.pageNumber],
            (old) =>
              old
                ? {
                    ...old,
                    fields: old.fields.map((f) =>
                      f.id === fieldId ? { ...f, value: correctedValue, source: 'MANUAL' } : f,
                    ),
                  }
                : old,
          );
        }

        setPending((prev) => {
          const next = { ...prev };
          target.forEach((fieldId) => delete next[fieldId]);
          return next;
        });

        setFeedback('saved', 'Saved ?');
      } catch (error) {
        setFeedback('error', error instanceof Error ? error.message : 'Save failed');
      }
    },
    [locations, pending, queryClient, setFeedback],
  );

  useEffect(() => {
    if (Object.keys(pending).length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      void savePending();
    }, 5000);

    return () => window.clearInterval(timer);
  }, [pending, savePending]);

  const reAuditMutation = useMutation({
    mutationFn: async () => {
      await apiClient.post(`/v1/claims/${claimId}/audit`, { body: {} });
    },
    onSuccess: async () => {
      setFeedback('saved', 'Re-audit triggered');
      await Promise.all([claimQuery.refetch(), auditQuery.refetch()]);
    },
    onError: (error) => {
      setFeedback('error', error instanceof Error ? error.message : 'Re-audit failed');
    },
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      setExportNotice(null);

      const enqueueResponse = await apiClient.post<ExportQueueResponse>(`/v1/claims/${claimId}/export`, {
        body: {},
      });

      const { jobId } = enqueueResponse.data;
      setActiveExportJob({ jobId, status: 'QUEUED' });

      let exportStatus: ExportJobStatus | null = null;

      for (let attempt = 0; attempt < 45; attempt += 1) {
        const statusResponse = await apiClient.get<ExportJobStatus>(`/v1/jobs/${jobId}`);
        exportStatus = statusResponse.data;
        setActiveExportJob({ jobId, status: exportStatus.status });

        if (exportStatus.status === 'COMPLETED') {
          break;
        }

        if (exportStatus.status === 'FAILED') {
          throw new Error(exportStatus.error ?? tAudit('exportFailed'));
        }

        await sleep(2000);
      }

      if (!exportStatus || exportStatus.status !== 'COMPLETED') {
        throw new Error(tAudit('exportTimeout'));
      }

      const token = getToken();
      const headers = new Headers();

      if (token) {
        headers.set('authorization', `Bearer ${token}`);
      }

      const downloadResponse = await fetch(`${getApiBaseUrl()}/v1/exports/${jobId}/download`, {
        method: 'GET',
        headers,
        credentials: 'include',
        cache: 'no-store',
      });

      if (!downloadResponse.ok) {
        throw new Error(tAudit('exportDownloadFailed'));
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

      return { jobId };
    },
    onSuccess: ({ jobId }) => {
      setExportNotice(tAudit('exportSuccess', { claimId }));
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
          : tAudit('exportFailed');
      setExportNotice(message);
      setActiveExportJob((previous) => (previous ? { ...previous, status: 'FAILED' } : previous));
    },
  });

  const overrideMutation = useMutation({
    mutationFn: async (reason: string) => apiClient.post(`/v1/claims/${claimId}/override`, { body: { reason } }),
    onSuccess: async () => {
      setFeedback('saved', 'Override requested');
      await claimQuery.refetch();
    },
    onError: (error) => {
      setFeedback('error', error instanceof Error ? error.message : 'Override request failed');
    },
  });

  const reviewIds = useMemo(
    () => fields.filter((f) => ['LOW', 'MEDIUM'].includes(f.confidenceTier.toUpperCase())).map((f) => f.id),
    [fields],
  );

  const goReview = useCallback(
    (direction: 1 | -1) => {
      if (reviewIds.length === 0) {
        return;
      }

      const index = selectedFieldId ? reviewIds.indexOf(selectedFieldId) : -1;
      const next = index < 0 ? 0 : (index + direction + reviewIds.length) % reviewIds.length;
      const fieldId = reviewIds[next];

      if (!fieldId) {
        return;
      }

      setSelectedFieldId(fieldId);
      fieldRefs.current[fieldId]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
    [reviewIds, selectedFieldId],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      const inInput =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.getAttribute('contenteditable') === 'true');

      if (event.key === 'Tab') {
        event.preventDefault();
        goReview(event.shiftKey ? -1 : 1);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void savePending();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        const high = fields.filter((f) => f.confidenceTier.toUpperCase() === 'HIGH' && f.value !== null);
        setPending((prev) => {
          const next = { ...prev };
          high.forEach((f) => {
            if (f.value !== null) {
              next[f.id] = f.value;
            }
          });
          return next;
        });
        void savePending(high.map((f) => f.id));
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();

        if (event.shiftKey) {
          const action = redoStack[redoStack.length - 1];
          if (!action) {
            return;
          }
          setRedoStack((prev) => prev.slice(0, -1));
          setUndoStack((prev) => [...prev, action]);
          setPending((prev) => {
            const next = { ...prev };
            if (action.to === action.base) {
              delete next[action.fieldId];
            } else {
              next[action.fieldId] = action.to;
            }
            return next;
          });
          setSelectedFieldId(action.fieldId);
        } else {
          const action = undoStack[undoStack.length - 1];
          if (!action) {
            return;
          }
          setUndoStack((prev) => prev.slice(0, -1));
          setRedoStack((prev) => [...prev, action]);
          setPending((prev) => {
            const next = { ...prev };
            if (action.from === action.base) {
              delete next[action.fieldId];
            } else {
              next[action.fieldId] = action.from;
            }
            return next;
          });
          setSelectedFieldId(action.fieldId);
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        reAuditMutation.mutate();
        return;
      }

      if (event.key === 'Enter' && selectedFieldId) {
        event.preventDefault();
        void savePending([selectedFieldId]);
        return;
      }

      if (!inInput && event.key === 'ArrowLeft') {
        event.preventDefault();
        setActivePageIndex((n) => Math.max(0, n - 1));
        return;
      }

      if (!inInput && event.key === 'ArrowRight') {
        event.preventDefault();
        setActivePageIndex((n) => Math.min(Math.max(0, pages.length - 1), n + 1));
        return;
      }

      if (event.key === 'Escape') {
        setSelectedFieldId(null);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fields, goReview, pages.length, reAuditMutation, redoStack, savePending, selectedFieldId, undoStack]);

  const selectedField = fields.find((f) => f.id === selectedFieldId) ?? null;

  const issuesCritical = (auditQuery.data?.findings ?? []).filter((r) => r.result === 'FAIL');
  const issuesWarning = (auditQuery.data?.findings ?? []).filter((r) => r.result === 'WARNING' || r.result === 'INCOMPLETE');
  const passedCount = (auditQuery.data?.findings ?? []).filter((r) => r.result === 'PASS').length;

  const jumpIssue = useCallback(
    (issue: AuditResult['findings'][number]) => {
      const key = String(issue.evidence?.field ?? issue.evidence?.field_key ?? issue.evidence?.fieldKey ?? '')
        .trim()
        .toLowerCase();

      if (key) {
        for (const [fieldId, loc] of locations.entries()) {
          if (loc.fieldKey.toLowerCase() === key) {
            const target = pages.findIndex((p) => p.key === loc.pageKey);
            if (target >= 0) {
              setActivePageIndex(target);
            }
            setSelectedFieldId(fieldId);
            return;
          }
        }
      }

      const docId = String(issue.evidence?.documentId ?? issue.evidence?.document_id ?? '').trim();
      const pageNumber = Number(issue.evidence?.page ?? issue.evidence?.pageNumber ?? issue.evidence?.page_number ?? 0);

      if (!docId || !Number.isInteger(pageNumber) || pageNumber < 1) {
        return;
      }

      const target = pages.findIndex((p) => p.docId === docId && p.pageNumber === pageNumber);
      if (target >= 0) {
        setActivePageIndex(target);
      }
    },
    [locations, pages],
  );

  const claim = claimQuery.data?.claim;
  const docUrl = page ? blobUrls[page.docId] ?? null : null;

  if (claimQuery.isLoading || docsQuery.isLoading) {
    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-6">
        <div className="glass-card p-5">
          <LoadingSpinner label="Loading audit workspace..." />
        </div>
      </main>
    );
  }

  if (!claim) {
    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-6">
        <div className="glass-card p-5 text-sm text-[var(--danger)]">Claim not found.</div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1400px] px-4 py-6">
      <PageHeader
        title={`Audit Workspace - ${claim.id}`}
        subtitle={`Rulepack ${auditQuery.data?.rulepackVersion ?? 'n/a'}`}
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: 'Claims', href: '/claims' },
          { label: claim.id, href: `/claims/${claim.id}` },
          { label: 'Audit' },
        ]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={claim.status} />
            <Link href="/claims" className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm">Back to Claims</Link>
            <button type="button" className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white" onClick={() => reAuditMutation.mutate()}>
              {reAuditMutation.isPending ? 'Re-auditing...' : 'Re-audit'}
            </button>
            <button
              type="button"
              className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
              onClick={() => {
                const reason = window.prompt('Enter override reason (minimum 20 characters):');
                if (!reason) {
                  return;
                }
                if (reason.trim().length < 20) {
                  setFeedback('error', 'Override reason must be at least 20 characters.');
                  return;
                }
                overrideMutation.mutate(reason.trim());
              }}
            >
              {overrideMutation.isPending ? 'Submitting...' : 'Override'}
            </button>
            <button
              type="button"
              className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => exportMutation.mutate()}
              disabled={exportMutation.isPending}
              title={tAudit('exportHint')}
            >
              {exportMutation.isPending ? tAudit('exporting') : tAudit('export')}
            </button>
          </div>
        }
      />

      <section className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--line)] bg-[var(--soft)]/80 px-4 py-2 text-sm">
        <p className="text-[var(--muted)]">Shortcuts: Tab/Shift+Tab, Enter, Ctrl+S, Ctrl+A, Ctrl+Z/Ctrl+Shift+Z, arrows, Ctrl+Enter, Esc.</p>
        <div className={clsx('rounded-full px-3 py-1 text-xs font-semibold', saveState === 'saving' && 'bg-sky-100 text-sky-800', saveState === 'saved' && 'bg-emerald-100 text-emerald-800', saveState === 'error' && 'bg-red-100 text-red-800', saveState === 'idle' && 'bg-slate-100 text-slate-700')}>
          {saveText ?? (Object.keys(pending).length > 0 ? 'Unsaved changes' : 'Saved ?')}
        </div>
      </section>

      {activeExportJob ? (
        <section className="mb-4 rounded-xl border border-[var(--line)] bg-white px-4 py-2 text-sm">
          {tAudit('exportProgress', { status: activeExportJob.status })}
        </section>
      ) : null}

      {exportNotice ? (
        <section className="mb-4 rounded-xl border border-[var(--line)] bg-white px-4 py-2 text-sm">
          {exportNotice}
        </section>
      ) : null}

      <section className="grid min-h-[70vh] gap-4 lg:grid-cols-[55%_45%]">
        <article className="glass-card flex min-h-[520px] flex-col p-4">
          <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-[var(--font-heading)] text-lg font-semibold">Document Viewer</h2>
              <p className="text-xs text-[var(--muted)]">{page ? `Document ${page.docOrdinal} (${page.docType}) | Page ${page.pageNumber}` : 'No pages available'}</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" className="rounded border border-[var(--line)] px-2 py-1 text-xs" onClick={() => setZoom((v) => Math.max(0.5, Number((v - 0.1).toFixed(2))))}>Zoom -</button>
              <span className="w-12 text-center text-xs">{Math.round(zoom * 100)}%</span>
              <button type="button" className="rounded border border-[var(--line)] px-2 py-1 text-xs" onClick={() => setZoom((v) => Math.min(2, Number((v + 0.1).toFixed(2))))}>Zoom +</button>
            </div>
          </header>

          <div className="mb-3 flex items-center justify-between gap-2">
            <button type="button" className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm" onClick={() => setActivePageIndex((n) => Math.max(0, n - 1))} disabled={activePageIndex <= 0}>Previous</button>
            <p className="text-xs text-[var(--muted)]">{pages.length > 0 ? `Page ${activePageIndex + 1} of ${pages.length}` : 'No pages'}</p>
            <button type="button" className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm" onClick={() => setActivePageIndex((n) => Math.min(Math.max(0, pages.length - 1), n + 1))} disabled={activePageIndex >= pages.length - 1}>Next</button>
          </div>

          <div className="mb-3 flex flex-wrap gap-1">
            {pages.map((p, i) => (
              <button key={p.key} type="button" className={clsx('rounded border px-2 py-1 text-[11px]', i === activePageIndex ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line)] bg-white text-[var(--muted)]')} onClick={() => setActivePageIndex(i)}>
                D{p.docOrdinal}-P{p.pageNumber}
              </button>
            ))}
          </div>

          <div className="relative flex-1 overflow-hidden rounded-xl border border-[var(--line)] bg-white">
            {!page ? (
              <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">Upload documents to start auditing.</div>
            ) : !docUrl ? (
              <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">{blobError ? blobError : 'Loading preview...'}</div>
            ) : (
              <div className="relative h-full w-full overflow-auto">
                {page.mimeType.startsWith('image/') ? (
                  <img src={docUrl} alt={`${page.originalFilename} page ${page.pageNumber}`} className="h-full w-full object-contain" style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }} />
                ) : (
                  <iframe title={`${page.originalFilename} preview`} src={`${docUrl}#page=${page.pageNumber}&zoom=${Math.round(zoom * 100)}`} className="h-full w-full" />
                )}
                {selectedField?.bbox ? <div className="pointer-events-none absolute border-2 border-blue-500 bg-blue-400/15" style={bboxStyle(selectedField.bbox)} /> : null}
              </div>
            )}
          </div>
        </article>

        <article className="glass-card flex min-h-[520px] flex-col p-4">
          <header className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="font-[var(--font-heading)] text-lg font-semibold">Extraction Editor</h2>
              <p className="text-xs text-[var(--muted)]">{currentExtraction ? `${fields.length} fields | OCR ${Math.round((currentExtraction.ocr.confidence ?? 0) * 100)}%` : 'No extraction loaded'}</p>
            </div>
            <button type="button" className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm" onClick={() => void savePending()}>
              Save (Ctrl+S)
            </button>
          </header>

          {extractionQuery.isLoading ? (
            <div className="flex flex-1 items-center justify-center"><LoadingSpinner size="sm" label="Loading extraction..." /></div>
          ) : extractionQuery.isError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{(extractionQuery.error as Error).message}</div>
          ) : fields.length === 0 ? (
            <div className="rounded-lg border border-[var(--line)] bg-white p-3 text-sm text-[var(--muted)]">No extracted fields for this page.</div>
          ) : (
            <div className="flex-1 space-y-2 overflow-y-auto pr-1">
              {fields.map((field) => {
                const ui = tierUi(field.confidenceTier);
                const base = field.value ?? '';
                const draft = pending[field.id] ?? base;

                return (
                  <div
                    key={field.id}
                    ref={(node) => {
                      fieldRefs.current[field.id] = node;
                    }}
                    className={clsx('rounded-xl border p-3', ui.card, selectedFieldId === field.id && 'ring-2 ring-[var(--accent)]')}
                    onClick={() => setSelectedFieldId(field.id)}
                  >
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">{fieldLabel(field.fieldKey)}</p>
                        <p className="text-[11px] text-[var(--muted)]">{field.fieldKey} | {Math.round(field.confidence * 100)}%</p>
                      </div>
                      <span className={clsx('rounded-full px-2 py-0.5 text-[11px] font-semibold', ui.chip)}>{ui.icon} {field.confidenceTier}</span>
                    </div>

                    <input
                      value={draft}
                      onBlur={() => void savePending([field.id])}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        const previousValue = pending[field.id] ?? base;
                        if (previousValue === nextValue) {
                          return;
                        }

                        setPending((prev) => {
                          const next = { ...prev };
                          if (nextValue === base) {
                            delete next[field.id];
                          } else {
                            next[field.id] = nextValue;
                          }
                          return next;
                        });

                        setUndoStack((prev) => [...prev, { fieldId: field.id, from: previousValue, to: nextValue, base }]);
                        setRedoStack([]);
                        setFeedback('idle', null);
                      }}
                      className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                    />

                    <div className="mt-2 flex items-center justify-between text-[11px] text-[var(--muted)]">
                      <span>Source: {field.source}</span>
                      <button type="button" className="rounded border border-[var(--line)] px-2 py-0.5" onClick={() => void savePending([field.id])}>Confirm (Enter)</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </article>
      </section>

      <section className="mt-4 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--soft)]/85">
        <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={() => setFixCollapsed((v) => !v)}>
          <div>
            <h3 className="font-[var(--font-heading)] text-base font-semibold">Fix Report</h3>
            <p className="text-xs text-[var(--muted)]">? {issuesCritical.length} critical | ?? {issuesWarning.length} warnings | ? {passedCount} passed</p>
          </div>
          <span className="text-xs font-semibold text-[var(--muted)]">{fixCollapsed ? 'Expand' : 'Collapse'}</span>
        </button>

        {!fixCollapsed ? (
          <div className="grid gap-4 border-t border-[var(--line)] p-4 lg:grid-cols-3">
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-red-700">Critical Issues</h4>
              {issuesCritical.length === 0 ? <p className="text-xs text-[var(--muted)]">No critical issues.</p> : issuesCritical.map((issue) => (
                <button key={issue.ruleId} type="button" className="w-full rounded-lg border border-red-200 bg-red-50 p-2 text-left" onClick={() => jumpIssue(issue)}>
                  <p className="text-xs font-semibold text-red-800">{issue.ruleId}</p>
                  <div className="mt-1 text-xs text-red-700 [&_p]:m-0 [&_ul]:my-1 [&_ol]:my-1 [&_a]:underline" dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(issue.message) }} />
                  {issue.remediation ? <div className="mt-1 text-[11px] text-red-900 [&_p]:m-0 [&_ul]:my-1 [&_ol]:my-1 [&_a]:underline" dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(`**Fix:** ${issue.remediation}`) }} /> : null}
                </button>
              ))}
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-amber-700">Warnings</h4>
              {issuesWarning.length === 0 ? <p className="text-xs text-[var(--muted)]">No warnings.</p> : issuesWarning.map((issue) => (
                <button key={issue.ruleId} type="button" className="w-full rounded-lg border border-amber-200 bg-amber-50 p-2 text-left" onClick={() => jumpIssue(issue)}>
                  <p className="text-xs font-semibold text-amber-900">{issue.ruleId}</p>
                  <div className="mt-1 text-xs text-amber-800 [&_p]:m-0 [&_ul]:my-1 [&_ol]:my-1 [&_a]:underline" dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(issue.message) }} />
                  {issue.remediation ? <div className="mt-1 text-[11px] text-amber-900 [&_p]:m-0 [&_ul]:my-1 [&_ol]:my-1 [&_a]:underline" dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(`**Fix:** ${issue.remediation}`) }} /> : null}
                </button>
              ))}
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-emerald-700">Audit Snapshot</h4>
              {auditQuery.data ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs">
                  <p>Decision: <span className="font-semibold">{auditQuery.data.decision ?? 'UNKNOWN'}</span></p>
                  <p className="mt-1">Rulepack: {auditQuery.data.rulepackVersion}</p>
                  <p className="mt-1">Failed: {auditQuery.data.failedCount}</p>
                  <p className="mt-1">Warnings: {auditQuery.data.warningCount}</p>
                  <p className="mt-1">Incomplete: {auditQuery.data.incompleteCount}</p>
                </div>
              ) : (
                <p className="text-xs text-[var(--muted)]">No audit session found yet for this claim.</p>
              )}
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

