// Thin fetch wrapper for the admin console (Session 11, D6).
//
// Cookie-based auth: the access token is httpOnly, so every call sends
// `credentials: 'include'` and there is never a token for JS to read or leak.
// Errors come back as the API's `{ error: <machine code> }` body so a page can
// show the code verbatim — the server-side `authorize('admin')` on every
// endpoint is the real boundary; nothing here elevates anything.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

export async function adminFetch<T>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown } = {},
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? 'GET',
      credentials: 'include',
      headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      return { ok: false, status: res.status, error: payload.error ?? String(res.status) };
    }
    return { ok: true, status: res.status, data: payload as T };
  } catch {
    return { ok: false, status: 0, error: 'network_error' };
  }
}

/** Minor units → an amount in the UI's locale. */
export function formatMoney(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

export function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}
