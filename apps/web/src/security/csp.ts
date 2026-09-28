// =============================================================================
// Content-Security-Policy for the web app (Session 12, D5).
//
// Pure: the proxy (`src/proxy.ts`) mints a fresh nonce per request and calls
// this; the unit test calls it directly. Next's App Router reads the nonce back out
// of the request's CSP header and stamps it on every script it renders, so
// `'strict-dynamic'` lets exactly those scripts (and what they load) run —
// no host allowlist for scripts, and never `'unsafe-inline'` for scripts.
//
// `style-src` does allow `'unsafe-inline'`: the pages style elements through
// React `style={…}` attributes, which CSP governs like inline <style>, and a
// nonce cannot be attached to an attribute. Styles cannot execute code; the
// script policy is what stops XSS.
// =============================================================================

export interface CspOptions {
  /** Per-request random nonce (base64). */
  nonce: string;
  /** Development adds `'unsafe-eval'` (React Refresh / dev overlay need it). */
  isDev: boolean;
  /** `NEXT_PUBLIC_API_URL` — the browser fetches it, loads images from it, and dials its WebSocket. */
  apiUrl?: string;
  /** `NEXT_PUBLIC_MEDIA_ORIGIN` — the storage host signed URLs point at. */
  mediaOrigin?: string;
}

/** `https://api.example.com/x` → `https://api.example.com`; junk → null. */
function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The WebSocket twin of an http(s) origin: http → ws, https → wss. */
function socketOriginOf(origin: string): string {
  return origin.replace(/^http/, 'ws');
}

export function buildContentSecurityPolicy({
  nonce,
  isDev,
  apiUrl,
  mediaOrigin,
}: CspOptions): string {
  const api = originOf(apiUrl);
  const media = originOf(mediaOrigin);
  const mediaSources = ["'self'", 'data:', 'blob:', api, media].filter(Boolean);

  const directives: Record<string, Array<string | null>> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      isDev ? "'unsafe-eval'" : null,
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': mediaSources,
    'media-src': mediaSources,
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", api, api ? socketOriginOf(api) : null],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };

  return Object.entries(directives)
    .map(([name, values]) => [name, ...new Set(values.filter(Boolean))].join(' '))
    .join('; ');
}

/** 128 random bits, base64 — Web Crypto only, so it runs in any runtime (Node.js proxy included). */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
