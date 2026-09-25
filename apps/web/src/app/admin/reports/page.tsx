'use client';

// Content reports — GET /api/admin/reports + resolve (Session 11, D5/D6).
//
// `details` is viewer-supplied free text. It is rendered as a React text node
// (escaped) — never through dangerouslySetInnerHTML.
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  ADMIN_REPORT_STATUS_FILTERS,
  REPORT_RESOLVE_ACTIONS,
  type AdminPage,
  type AdminReportListItem,
  type AdminReportStatusFilter,
  type AdminResolveReportResponse,
  type ReportResolveAction,
} from '@creator-platform/shared';
import { adminFetch, formatDate } from '../../../components/admin/api';
import { ConfirmAction } from '../../../components/admin/ConfirmAction';
import { Pager } from '../../../components/admin/Pager';
import { adminStyles as s } from '../../../components/admin/styles';

const LIMIT = 10;

function ReportCard({
  report,
  onResolved,
  onError,
}: {
  report: AdminReportListItem;
  onResolved: () => Promise<void>;
  onError: (error: string) => void;
}) {
  const t = useTranslations('admin.reports');
  const locale = useLocale();
  const [action, setAction] = useState<ReportResolveAction>('none');
  const selectId = `report-action-${report.reportId}`;

  async function resolve() {
    const res = await adminFetch<AdminResolveReportResponse>(
      `/api/admin/reports/${report.reportId}/resolve`,
      { method: 'POST', body: { action } },
    );
    if (!res.ok) {
      onError(res.error);
      return;
    }
    await onResolved();
  }

  const contentState = report.content.deletedAt
    ? t('deleted')
    : report.content.isPublished
      ? t('published')
      : t('unpublished');

  return (
    <section style={s.card} aria-labelledby={`report-${report.reportId}`}>
      <div style={{ ...s.row, justifyContent: 'space-between' }}>
        <h3 id={`report-${report.reportId}`} style={{ margin: 0, fontSize: '1.05rem' }}>
          {t(`reason.${report.reason}`)}
        </h3>
        <span style={s.badge}>{report.status}</span>
      </div>
      <p style={s.muted}>
        {t('reportedBy', {
          email: report.reporter.email,
          when: formatDate(report.createdAt, locale),
        })}
      </p>
      <p style={{ margin: '0.5rem 0' }}>
        <strong>{t('details')}:</strong> {report.details ?? t('noDetails')}
      </p>
      <p style={{ margin: '0.5rem 0' }}>
        <strong>{t('content')}:</strong> {report.content.title}{' '}
        <span style={s.badge}>{report.content.type}</span>{' '}
        <span style={s.badge}>{report.content.tier}</span>{' '}
        <span style={s.badge}>{contentState}</span>
      </p>
      <p style={{ margin: '0.5rem 0' }}>
        <strong>{t('owner')}:</strong> {report.content.owner.displayName} (
        {report.content.owner.email}){' '}
        {report.content.owner.suspendedAt && <span style={s.badge}>{t('ownerSuspended')}</span>}
      </p>

      {report.status === 'PENDING' ? (
        <ConfirmAction
          label={t('resolve')}
          prompt={t('resolvePrompt', { action: t(`action.${action}`) })}
          variant={action === 'none' ? 'primary' : 'danger'}
          onConfirm={resolve}
        >
          <div style={{ margin: '0.5rem 0' }}>
            <label htmlFor={selectId} style={s.label}>
              {t('actionLabel')}
            </label>
            <select
              id={selectId}
              style={s.input}
              value={action}
              onChange={(e) => setAction(e.target.value as ReportResolveAction)}
            >
              {REPORT_RESOLVE_ACTIONS.map((option) => (
                <option key={option} value={option}>
                  {t(`action.${option}`)}
                </option>
              ))}
            </select>
          </div>
        </ConfirmAction>
      ) : (
        <p style={s.muted}>
          {t('resolvedAs', {
            when: formatDate(report.resolvedAt, locale),
            action: report.resolvedAction ? t(`action.${report.resolvedAction}`) : '—',
          })}
        </p>
      )}
    </section>
  );
}

export default function AdminReportsPage() {
  const t = useTranslations('admin.reports');
  const tc = useTranslations('admin.common');
  const [filter, setFilter] = useState<AdminReportStatusFilter>('pending');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AdminPage<AdminReportListItem> | null>(null);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setStatus(tc('loading'));
    const res = await adminFetch<AdminPage<AdminReportListItem>>(
      `/api/admin/reports?status=${filter}&limit=${LIMIT}&offset=${offset}`,
    );
    if (!res.ok) {
      setStatus(tc('loadFailed'));
      return;
    }
    setPage(res.data);
    setStatus('');
  }, [filter, offset, tc]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <section style={s.card} aria-labelledby="reports-heading">
        <h2 id="reports-heading" style={s.h2}>
          {t('heading')}
        </h2>
        <p style={s.muted}>{t('intro')}</p>
        <div style={s.row}>
          <label htmlFor="reports-status" style={s.label}>
            {tc('statusFilter')}
          </label>
          <select
            id="reports-status"
            style={s.input}
            value={filter}
            onChange={(e) => {
              setOffset(0);
              setFilter(e.target.value as AdminReportStatusFilter);
            }}
          >
            {ADMIN_REPORT_STATUS_FILTERS.map((option) => (
              <option key={option} value={option}>
                {t(`filter.${option}`)}
              </option>
            ))}
          </select>
          <button type="button" style={s.buttonGhost} onClick={() => void load()}>
            {tc('refresh')}
          </button>
        </div>
        <p role="status" aria-live="polite" style={s.status}>
          {status}
        </p>
      </section>

      {page && page.items.length === 0 && (
        <section style={s.card}>
          <p style={{ margin: 0 }}>{tc('empty')}</p>
        </section>
      )}

      {page?.items.map((report) => (
        <ReportCard
          key={report.reportId}
          report={report}
          onResolved={async () => {
            setStatus(t('resolvedDone'));
            await load();
          }}
          onError={(error) => setStatus(tc('actionFailed', { error }))}
        />
      ))}

      {page && (
        <Pager total={page.total} limit={page.limit} offset={page.offset} onChange={setOffset} />
      )}
    </>
  );
}
