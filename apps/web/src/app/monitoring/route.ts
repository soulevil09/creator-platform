// Sentry tunnel endpoint (Session 13, D3). All policy lives in
// src/security/sentry-tunnel.ts: only envelopes for OUR DSN are forwarded, to
// a destination derived from our DSN — never an open relay. The browser's IP
// is not forwarded (no X-Forwarded-For), so Sentry sees this server, not users.
import { TUNNEL_MAX_BYTES, decideTunnel, tunnelTarget } from '../../security/sentry-tunnel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > TUNNEL_MAX_BYTES) return new Response(null, { status: 413 });

  const body = await request.text();
  const decision = decideTunnel(tunnelTarget(process.env.NEXT_PUBLIC_SENTRY_DSN), body);
  if (!decision.ok) return new Response(null, { status: decision.status });

  try {
    const upstream = await fetch(decision.forwardTo, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope' },
      body,
    });
    return new Response(null, { status: upstream.ok ? 200 : 502 });
  } catch {
    return new Response(null, { status: 502 });
  }
}
