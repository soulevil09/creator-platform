'use client';

// Model approval queue — GET /api/admin/models + approve/reject (Session 11, D1/D6).
//
// Reference images are the 300 s signed URLs the API mints per request; they
// are shown with a plain <img> (unknown remote host, single-use — same
// reasoning as the wallet's PIX QR) and are never cached or stored here.
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  ADMIN_MODEL_STATUS_FILTERS,
  type AdminModelDecisionResponse,
  type AdminModelListItem,
  type AdminModelStatusFilter,
  type AdminPage,
} from '@creator-platform/shared';
import { adminFetch, formatDate } from '../../../components/admin/api';
import { ConfirmAction } from '../../../components/admin/ConfirmAction';
import { Pager } from '../../../components/admin/Pager';
import { adminStyles as s } from '../../../components/admin/styles';

const LIMIT = 10;

export default function AdminModelsPage() {
  const t = useTranslations('admin.models');
  const tc = useTranslations('admin.common');
  const locale = useLocale();
  const [filter, setFilter] = useState<AdminModelStatusFilter>('pending');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AdminPage<AdminModelListItem> | null>(null);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setStatus(tc('loading'));
    const res = await adminFetch<AdminPage<AdminModelListItem>>(
      `/api/admin/models?status=${filter}&limit=${LIMIT}&offset=${offset}`,
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

  async function decide(item: AdminModelListItem, verb: 'approve' | 'reject', reason?: string) {
    const res = await adminFetch<AdminModelDecisionResponse>(
      `/api/admin/models/${item.userId}/${verb}`,
      { method: 'POST', body: verb === 'reject' ? { reason } : undefined },
    );
    if (!res.ok) {
      setStatus(tc('actionFailed', { error: res.error }));
      return;
    }
    setStatus(t(verb === 'approve' ? 'approved' : 'rejected', { name: item.profile.displayName }));
    await load();
  }

  const yesNo = (v: boolean) => (v ? tc('yes') : tc('no'));

  return (
    <>
      <section style={s.card} aria-labelledby="models-heading">
        <h2 id="models-heading" style={s.h2}>
          {t('heading')}
        </h2>
        <p style={s.muted}>{t('intro')}</p>
        <div style={s.row}>
          <label htmlFor="models-status" style={s.label}>
            {tc('statusFilter')}
          </label>
          <select
            id="models-status"
            style={s.input}
            value={filter}
            onChange={(e) => {
              setOffset(0);
              setFilter(e.target.value as AdminModelStatusFilter);
            }}
          >
            {ADMIN_MODEL_STATUS_FILTERS.map((option) => (
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

      {page?.items.map((item) => (
        <section key={item.userId} style={s.card} aria-labelledby={`model-${item.userId}`}>
          <div style={{ ...s.row, justifyContent: 'space-between' }}>
            <h3 id={`model-${item.userId}`} style={{ margin: 0, fontSize: '1.05rem' }}>
              {item.profile.displayName}{' '}
              <span style={{ ...s.muted, fontWeight: 400 }}>({item.email})</span>
            </h3>
            <span style={s.badge}>{t(`status.${item.profile.approvalStatus}`)}</span>
          </div>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr',
              gap: '0.25rem 1rem',
              margin: '0.75rem 0',
              fontSize: '0.9rem',
            }}
          >
            <dt style={s.muted}>{t('emailVerified')}</dt>
            <dd style={{ margin: 0 }}>{yesNo(item.isVerified)}</dd>
            <dt style={s.muted}>{t('aiConsent')}</dt>
            <dd style={{ margin: 0 }}>{yesNo(item.profile.aiConsent)}</dd>
            <dt style={s.muted}>{t('tos')}</dt>
            <dd style={{ margin: 0 }}>{formatDate(item.profile.tosAcceptedAt, locale)}</dd>
            <dt style={s.muted}>{t('country')}</dt>
            <dd style={{ margin: 0 }}>{item.profile.country}</dd>
            <dt style={s.muted}>{t('currency')}</dt>
            <dd style={{ margin: 0 }}>{item.profile.currency}</dd>
            <dt style={s.muted}>{t('joined')}</dt>
            <dd style={{ margin: 0 }}>{formatDate(item.profile.createdAt, locale)}</dd>
            {item.profile.approvalReviewedAt && (
              <>
                <dt style={s.muted}>{t('reviewedAt')}</dt>
                <dd style={{ margin: 0 }}>{formatDate(item.profile.approvalReviewedAt, locale)}</dd>
              </>
            )}
            {item.profile.approvalRejectionReason && (
              <>
                <dt style={s.muted}>{t('rejectionReason')}</dt>
                {/* Free text from the audit trail: React escapes it — never dangerouslySetInnerHTML. */}
                <dd style={{ margin: 0 }}>{item.profile.approvalRejectionReason}</dd>
              </>
            )}
          </dl>
          {item.profile.bio && <p style={{ margin: '0 0 0.75rem' }}>{item.profile.bio}</p>}

          <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}>{t('referenceImages')}</h4>
          {item.referenceImages.length === 0 ? (
            <p style={s.muted}>{t('noReferenceImages')}</p>
          ) : (
            <ul style={{ ...s.row, listStyle: 'none', padding: 0, margin: '0 0 0.75rem' }}>
              {item.referenceImages.map((img, index) => (
                <li key={img.imageId}>
                  <img
                    src={img.signedUrl}
                    alt={t('referenceImageAlt', { n: index + 1, name: item.profile.displayName })}
                    width={120}
                    height={120}
                    style={s.thumb}
                  />
                </li>
              ))}
            </ul>
          )}

          <div style={s.row}>
            {item.profile.approvalStatus !== 'APPROVED' && (
              <ConfirmAction
                label={t('approve')}
                prompt={t('approvePrompt', { name: item.profile.displayName })}
                onConfirm={() => decide(item, 'approve')}
              />
            )}
            {item.profile.approvalStatus !== 'REJECTED' && (
              <ConfirmAction
                label={t('reject')}
                variant="danger"
                prompt={t('rejectPrompt', { name: item.profile.displayName })}
                reasonLabel={t('reasonLabel')}
                requireReason
                onConfirm={(reason) => decide(item, 'reject', reason)}
              />
            )}
          </div>
        </section>
      ))}

      {page && (
        <Pager total={page.total} limit={page.limit} offset={page.offset} onChange={setOffset} />
      )}
    </>
  );
}
