'use client';

// Client-side gate for /admin/* (Session 11, D6).
//
// This is a UX convenience, NOT a security control: it asks `GET /api/auth/me`
// and sends anyone who is not an admin back to `/` so they never see an empty
// console. The actual boundary is `authenticate` + `authorize('admin')` on
// every `/api/admin/*` endpoint — a caller who bypasses this component gets
// 401/403 from the API on every request, exactly as they would without it.
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { AuthUser } from '@creator-platform/shared';
import { adminFetch } from './api';
import { adminStyles as s } from './styles';

type GateState = 'checking' | 'allowed' | 'redirecting' | 'failed';

export function AdminGate({ children }: { children: ReactNode }) {
  const t = useTranslations('admin.gate');
  const router = useRouter();
  const [state, setState] = useState<GateState>('checking');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const me = await adminFetch<Pick<AuthUser, 'role'>>('/api/auth/me');
      if (cancelled) return;
      if (me.ok && me.data.role === 'admin') {
        setState('allowed');
        return;
      }
      if (me.ok || me.status === 401 || me.status === 403) {
        setState('redirecting');
        router.replace('/');
        return;
      }
      setState('failed');
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (state === 'allowed') return <>{children}</>;
  return (
    <p role="status" aria-live="polite" style={s.status}>
      {state === 'checking'
        ? t('checking')
        : state === 'redirecting'
          ? t('redirecting')
          : t('failed')}
    </p>
  );
}
