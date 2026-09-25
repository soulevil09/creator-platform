'use client';

// Offset pager matching the API's `{ total, limit, offset }` envelope.
import { useTranslations } from 'next-intl';
import { adminStyles as s } from './styles';

export function Pager({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  const t = useTranslations('admin.common');
  if (total === 0) return null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div style={{ ...s.row, marginTop: '0.75rem', justifyContent: 'space-between' }}>
      <span style={s.muted}>{t('pageInfo', { from, to, total })}</span>
      <div style={s.row}>
        <button
          type="button"
          style={s.buttonGhost}
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          {t('previous')}
        </button>
        <button
          type="button"
          style={s.buttonGhost}
          disabled={to >= total}
          onClick={() => onChange(offset + limit)}
        >
          {t('next')}
        </button>
      </div>
    </div>
  );
}
