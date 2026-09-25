'use client';

// Payouts — the existing GET /api/payouts (Session 06, admin-only) plus the
// manual POST /api/admin/payouts/run (Session 11, D4/D6). Nothing here
// re-implements the listing; the dashboard consumes it as-is.
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { PayoutListResponse, PayoutRunSummary } from '@creator-platform/shared';
import { adminFetch, formatDate, formatMoney } from '../../../components/admin/api';
import { ConfirmAction } from '../../../components/admin/ConfirmAction';
import { Pager } from '../../../components/admin/Pager';
import { adminStyles as s } from '../../../components/admin/styles';

const LIMIT = 25;

export default function AdminPayoutsPage() {
  const t = useTranslations('admin.payouts');
  const tc = useTranslations('admin.common');
  const locale = useLocale();
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<PayoutListResponse | null>(null);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setStatus(tc('loading'));
    const res = await adminFetch<PayoutListResponse>(
      `/api/payouts?limit=${LIMIT}&offset=${offset}`,
    );
    if (!res.ok) {
      setStatus(tc('loadFailed'));
      return;
    }
    setPage(res.data);
    setStatus('');
  }, [offset, tc]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runNow() {
    const res = await adminFetch<PayoutRunSummary>('/api/admin/payouts/run', { method: 'POST' });
    if (!res.ok) {
      setStatus(tc('actionFailed', { error: res.error }));
      return;
    }
    setStatus(
      t('runDone', {
        processed: res.data.processed,
        skipped: res.data.skipped,
        failed: res.data.failed,
        // The run summary is minor units in the settlement currency (BRL by
        // default — PAYOUT_CURRENCY); see the FX Open Item in CLAUDE.md.
        total: formatMoney(res.data.totalCents, 'BRL', locale),
      }),
    );
    setOffset(0);
    await load();
  }

  return (
    <>
      <section style={s.card} aria-labelledby="payouts-heading">
        <h2 id="payouts-heading" style={s.h2}>
          {t('heading')}
        </h2>
        <p style={s.muted}>{t('intro')}</p>
        <div style={s.row}>
          <ConfirmAction label={t('runNow')} prompt={t('runPrompt')} onConfirm={runNow} />
          <button type="button" style={s.buttonGhost} onClick={() => void load()}>
            {tc('refresh')}
          </button>
        </div>
        <p role="status" aria-live="polite" style={s.status}>
          {status}
        </p>
      </section>

      {page && (
        <section style={s.card}>
          {page.payouts.length === 0 ? (
            <p style={{ margin: 0 }}>{tc('empty')}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th} scope="col">
                      {t('columns.payoutId')}
                    </th>
                    <th style={s.th} scope="col">
                      {t('columns.modelId')}
                    </th>
                    <th style={s.th} scope="col">
                      {t('columns.amount')}
                    </th>
                    <th style={s.th} scope="col">
                      {t('columns.status')}
                    </th>
                    <th style={s.th} scope="col">
                      {t('columns.provider')}
                    </th>
                    <th style={s.th} scope="col">
                      {t('columns.period')}
                    </th>
                    <th style={s.th} scope="col">
                      {t('columns.createdAt')}
                    </th>
                    <th style={s.th} scope="col">
                      {t('columns.failureReason')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page.payouts.map((payout) => (
                    <tr key={payout.payoutId}>
                      <td style={s.td}>
                        <code>{payout.payoutId}</code>
                      </td>
                      <td style={s.td}>
                        <code>{payout.modelId}</code>
                      </td>
                      <td style={s.td}>
                        {formatMoney(payout.amountCents, payout.currency, locale)}
                      </td>
                      <td style={s.td}>
                        <span style={s.badge}>{payout.status}</span>
                      </td>
                      <td style={s.td}>{payout.provider}</td>
                      <td style={s.td}>
                        {formatDate(payout.periodStart, locale)} –{' '}
                        {formatDate(payout.periodEnd, locale)}
                      </td>
                      <td style={s.td}>{formatDate(payout.createdAt, locale)}</td>
                      <td style={s.td}>{payout.failureReason ?? tc('none')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager total={page.total} limit={page.limit} offset={page.offset} onChange={setOffset} />
        </section>
      )}
    </>
  );
}
