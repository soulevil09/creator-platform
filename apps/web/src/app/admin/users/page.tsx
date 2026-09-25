'use client';

// Users — GET /api/admin/users + suspend/reinstate (Session 11, D2/D6).
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  USER_ROLES,
  type AdminPage,
  type AdminSuspendResponse,
  type AdminUserListItem,
  type Role,
} from '@creator-platform/shared';
import { adminFetch, formatDate } from '../../../components/admin/api';
import { ConfirmAction } from '../../../components/admin/ConfirmAction';
import { Pager } from '../../../components/admin/Pager';
import { adminStyles as s } from '../../../components/admin/styles';

const LIMIT = 25;

export default function AdminUsersPage() {
  const t = useTranslations('admin.users');
  const tc = useTranslations('admin.common');
  const locale = useLocale();
  const [emailInput, setEmailInput] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role | ''>('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AdminPage<AdminUserListItem> | null>(null);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setStatus(tc('loading'));
    const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
    if (email) params.set('email', email);
    if (role) params.set('role', role);
    const res = await adminFetch<AdminPage<AdminUserListItem>>(`/api/admin/users?${params}`);
    if (!res.ok) {
      setStatus(tc('loadFailed'));
      return;
    }
    setPage(res.data);
    setStatus('');
  }, [email, role, offset, tc]);

  useEffect(() => {
    void load();
  }, [load]);

  function search(event: FormEvent) {
    event.preventDefault();
    setOffset(0);
    setEmail(emailInput.trim());
  }

  async function toggle(user: AdminUserListItem, verb: 'suspend' | 'reinstate', reason?: string) {
    const res = await adminFetch<AdminSuspendResponse>(`/api/admin/users/${user.id}/${verb}`, {
      method: 'POST',
      body: verb === 'suspend' ? { reason } : undefined,
    });
    if (!res.ok) {
      setStatus(tc('actionFailed', { error: res.error }));
      return;
    }
    setStatus(t(verb === 'suspend' ? 'suspendedDone' : 'reinstatedDone', { email: user.email }));
    await load();
  }

  return (
    <>
      <section style={s.card} aria-labelledby="users-heading">
        <h2 id="users-heading" style={s.h2}>
          {t('heading')}
        </h2>
        <form onSubmit={search} style={{ ...s.row, alignItems: 'flex-end' }}>
          <div>
            <label htmlFor="users-email" style={s.label}>
              {t('search')}
            </label>
            <input
              id="users-email"
              type="search"
              style={s.input}
              value={emailInput}
              placeholder={t('searchPlaceholder')}
              onChange={(e) => setEmailInput(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="users-role" style={s.label}>
              {t('roleFilter')}
            </label>
            <select
              id="users-role"
              style={s.input}
              value={role}
              onChange={(e) => {
                setOffset(0);
                setRole(e.target.value as Role | '');
              }}
            >
              <option value="">{t('anyRole')}</option>
              {USER_ROLES.map((option) => (
                <option key={option} value={option}>
                  {t(`role.${option}`)}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" style={s.button}>
            {t('search')}
          </button>
        </form>
        <p role="status" aria-live="polite" style={s.status}>
          {status}
        </p>
      </section>

      {page && (
        <section style={s.card}>
          {page.items.length === 0 ? (
            <p style={{ margin: 0 }}>{tc('empty')}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th} scope="col">
                      {t('columns.email')}
                    </th>
                    <th style={s.th} scope="col">
                      {t('columns.displayName')}
                    </th>
                    <th style={s.th} scope="col">
                      {t('columns.role')}
                    </th>
                    <th style={s.th} scope="col">
                      {t('columns.verified')}
                    </th>
                    <th style={s.th} scope="col">
                      {t('columns.status')}
                    </th>
                    <th style={s.th} scope="col">
                      {t('columns.createdAt')}
                    </th>
                    <th style={s.th} scope="col">
                      {t('columns.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((user) => (
                    <tr key={user.id}>
                      <td style={s.td}>{user.email}</td>
                      <td style={s.td}>{user.displayName}</td>
                      <td style={s.td}>{t(`role.${user.role}`)}</td>
                      <td style={s.td}>{user.isVerified ? tc('yes') : tc('no')}</td>
                      <td style={s.td}>
                        {user.suspendedAt
                          ? t('suspended', { when: formatDate(user.suspendedAt, locale) })
                          : t('active')}
                      </td>
                      <td style={s.td}>{formatDate(user.createdAt, locale)}</td>
                      <td style={s.td}>
                        {user.role === 'admin' ? (
                          <span style={s.muted}>{t('adminProtected')}</span>
                        ) : user.suspendedAt ? (
                          <ConfirmAction
                            label={t('reinstate')}
                            prompt={t('reinstatePrompt', { email: user.email })}
                            onConfirm={() => toggle(user, 'reinstate')}
                          />
                        ) : (
                          <ConfirmAction
                            label={t('suspend')}
                            variant="danger"
                            prompt={t('suspendPrompt', { email: user.email })}
                            reasonLabel={t('suspendReason')}
                            onConfirm={(reason) => toggle(user, 'suspend', reason)}
                          />
                        )}
                      </td>
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
