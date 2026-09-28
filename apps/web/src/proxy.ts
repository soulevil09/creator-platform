// Per-request CSP nonce (Session 12, D5) — the Next 16 Proxy pattern.
//
// `src/middleware.ts` / `middleware()` was renamed to proxy in Session 12.6:
// Next 16 replaced that file convention with Proxy (`src/proxy.ts`, exported
// `proxy`, Node.js runtime). The logic below is unchanged by the rename.
//
// A fresh nonce is minted for every document request and put in the
// Content-Security-Policy on BOTH the forwarded request (Next reads it from
// there and stamps it onto every script it renders) and the response (what
// the browser enforces). The static security headers live in next.config.mjs.
//
// Locale resolution is untouched: the forwarded request carries the original
// headers — `NEXT_LOCALE` cookie and `Accept-Language` included — plus the two
// CSP headers, and nothing here reads or rewrites the locale.
import { NextResponse, type NextRequest } from 'next/server';
import { buildContentSecurityPolicy, createNonce } from './security/csp';

export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
    mediaOrigin: process.env.NEXT_PUBLIC_MEDIA_ORIGIN,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Documents only: static assets and the image optimiser need no nonce,
      // and prefetches are not rendered as documents.
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
