// Admin console shell (Session 11, D6): the first genuinely admin-facing
// surface in the app. `AdminGate` redirects non-admins away as a convenience;
// every endpoint the sections call is `authorize('admin')` on the server, and
// that check is the boundary — nothing here weakens or bypasses it.
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { AdminGate } from '../../components/admin/AdminGate';
import { AdminNav } from '../../components/admin/AdminNav';
import { adminStyles as s } from '../../components/admin/styles';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('admin');
  return (
    <main style={s.main}>
      <div style={s.shell}>
        <h1 style={s.h1}>{t('title')}</h1>
        <AdminNav />
        <AdminGate>{children}</AdminGate>
      </div>
    </main>
  );
}
