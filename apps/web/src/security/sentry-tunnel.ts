// =============================================================================
// Sentry tunnel (Session 13, D3) — the pure half of `/monitoring`.
//
// The browser SDK posts its envelopes to our own origin (`tunnel: '/monitoring'`)
// so the CSP `connect-src` never has to name a Sentry host. The tunnel then
// forwards each envelope to Sentry.
//
// Why not `withSentryConfig({ tunnelRoute })`: its rewrite builds the upstream
// URL from the request's own `?o=<org>&p=<project>` query, so it forwards to ANY
// Sentry project — an open relay on our domain. This tunnel accepts an envelope
// only if the DSN in its header is exactly ours, and the destination is derived
// from our DSN, never from the request. Junk that passes the size cap and names
// our DSN costs Sentry quota (rate-limited by Sentry per project), nothing else.
// =============================================================================

/** Envelopes above this are refused (413). Error envelopes are a few KB. */
export const TUNNEL_MAX_BYTES = 256 * 1024;

export interface TunnelTarget {
  /** Sentry ingest endpoint for our project. */
  url: string;
  /** host + project id — what an envelope's DSN must match. */
  host: string;
  projectId: string;
  publicKey: string;
}

/** Parse our DSN (`https://<key>@<host>/<projectId>`) into the forward target. */
export function tunnelTarget(dsn: string | undefined): TunnelTarget | null {
  if (!dsn) return null;
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const projectId = url.pathname.replace(/^\/+|\/+$/g, '');
  if (url.protocol !== 'https:' || !url.username || !/^\d+$/.test(projectId)) return null;
  return {
    url: `https://${url.host}/api/${projectId}/envelope/`,
    host: url.host,
    projectId,
    publicKey: url.username,
  };
}

export type TunnelDecision =
  | { ok: true; forwardTo: string }
  | { ok: false; status: 400 | 404 | 413 };

/**
 * Decide what to do with one envelope body. `ours` is `tunnelTarget(DSN)`;
 * null means Sentry is not configured, and the route does not exist (404).
 */
export function decideTunnel(ours: TunnelTarget | null, body: string): TunnelDecision {
  if (!ours) return { ok: false, status: 404 };
  if (Buffer.byteLength(body, 'utf8') > TUNNEL_MAX_BYTES) return { ok: false, status: 413 };
  const newline = body.indexOf('\n');
  const headerLine = newline === -1 ? body : body.slice(0, newline);
  let theirs: TunnelTarget | null;
  try {
    const header = JSON.parse(headerLine) as { dsn?: unknown };
    theirs = typeof header.dsn === 'string' ? tunnelTarget(header.dsn) : null;
  } catch {
    return { ok: false, status: 400 };
  }
  const matches =
    theirs !== null &&
    theirs.host === ours.host &&
    theirs.projectId === ours.projectId &&
    theirs.publicKey === ours.publicKey;
  return matches ? { ok: true, forwardTo: ours.url } : { ok: false, status: 400 };
}
