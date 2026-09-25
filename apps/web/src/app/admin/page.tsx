'use client';

// Overview — GET /api/admin/metrics/overview (Session 11, D3/D6).
//
// Every money figure is rendered per currency exactly as the API returns it;
// nothing on this page adds two currencies together.
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { AdminMetricsOverview } from '@creator-platform/shared';
import { adminFetch, formatDate, formatMoney } from '../../components/admin/api';
import { adminStyles as s } from '../../components/admin/styles';

export default function AdminOverviewPage() {
  const t = useTranslations('admin.overview');
  const tc = useTranslations('admin.common');
  const locale = useLocale();
  const [data, setData] = useState<AdminMetricsOverview | null>(null);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setStatus(tc('loading'));
    const res = await adminFetch<AdminMetricsOverview>('/api/admin/metrics/overview');
    if (!res.ok) {
      setStatus(tc('loadFailed'));
      return;
    }
    setData(res.data);
    setStatus('');
  }, [tc]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <section style={s.card} aria-labelledby="overview-heading">
        <div style={{ ...s.row, justifyContent: 'space-between' }}>
          <h2 id="overview-heading" style={s.h2}>
            {t('heading')}
          </h2>
          <button type="button" style={s.buttonGhost} onClick={() => void load()}>
            {tc('refresh')}
          </button>
        </div>
        {data && (
          <p style={s.muted}>
            {t('window', { days: data.windowDays })}{' '}
            {t('generatedAt', { when: formatDate(data.generatedAt, locale) })}
          </p>
        )}
        <p role="status" aria-live="polite" style={s.status}>
          {status}
        </p>
      </section>

      {data && (
        <>
          <section style={s.card} aria-labelledby="subs-heading">
            <h2 id="subs-heading" style={s.h2}>
              {t('subscriptions')}
            </h2>
            <p style={{ fontSize: '2rem', fontWeight: 700, margin: 0 }}>
              {data.subscriptions.active.total}
            </p>
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem' }}>
              {Object.entries(data.subscriptions.active.byTier).map(([tier, count]) => (
                <li key={tier}>{t('byTier', { tier, count })}</li>
              ))}
            </ul>
            <p style={{ margin: '0.75rem 0 0' }}>
              {t('subscribers')}: <strong>{data.subscribers.active}</strong>
            </p>
          </section>

          <section style={s.card} aria-labelledby="mrr-heading">
            <h2 id="mrr-heading" style={s.h2}>
              {t('recurring')}
            </h2>
            <p style={s.muted}>{t('recurringNote')}</p>
            {data.recurringRevenue.byCurrency.length === 0 ? (
              <p>{tc('empty')}</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                {data.recurringRevenue.byCurrency.map((row) => (
                  <li key={row.currency}>
                    <strong>{row.currency}</strong>:{' '}
                    {t('recurringRow', {
                      amount: formatMoney(row.amountCents, row.currency, locale),
                      count: row.subscriptions,
                    })}
                  </li>
                ))}
              </ul>
            )}
            {data.recurringRevenue.unattributedSubscriptions > 0 && (
              <p style={s.muted}>
                {t('unattributed', { count: data.recurringRevenue.unattributedSubscriptions })}
              </p>
            )}
          </section>

          <section style={s.card} aria-labelledby="packs-heading">
            <h2 id="packs-heading" style={s.h2}>
              {t('creditPacks')}
            </h2>
            {data.creditPackRevenue.byCurrency.length === 0 ? (
              <p>{tc('empty')}</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                {data.creditPackRevenue.byCurrency.map((row) => (
                  <li key={row.currency}>
                    <strong>{row.currency}</strong>:{' '}
                    {formatMoney(row.amountCents, row.currency, locale)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={s.card} aria-labelledby="gen-heading">
            <h2 id="gen-heading" style={s.h2}>
              {t('generations')}
            </h2>
            <p style={{ margin: 0 }}>
              {t('generationsSummary', {
                total: data.generations.total,
                completed: data.generations.completed,
                failed: data.generations.failed,
                pending: data.generations.pending,
              })}
            </p>
            <p style={s.muted}>
              {data.generations.completionRate === null
                ? t('completionRateNone')
                : t('completionRate', {
                    rate: new Intl.NumberFormat(locale, {
                      style: 'percent',
                      maximumFractionDigits: 1,
                    }).format(data.generations.completionRate),
                  })}
            </p>
          </section>

          <section style={s.card} aria-labelledby="payouts-heading">
            <h2 id="payouts-heading" style={s.h2}>
              {t('payouts')}
            </h2>
            {data.payouts.byStatus.length === 0 ? (
              <p>{tc('empty')}</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                {data.payouts.byStatus.map((row) => (
                  <li key={`${row.status}-${row.currency}`}>
                    {t('payoutRow', {
                      status: row.status,
                      currency: row.currency,
                      amount: formatMoney(row.amountCents, row.currency, locale),
                      count: row.count,
                    })}
                  </li>
                ))}
              </ul>
            )}
            <p style={{ margin: '0.75rem 0 0', color: '#fbbf24' }}>
              {t('noDestination', {
                count: data.payouts.modelsAboveThresholdWithoutPayoutEmail,
                threshold: formatMoney(data.payouts.thresholdCents, 'BRL', locale),
              })}
            </p>
          </section>
        </>
      )}
    </>
  );
}
