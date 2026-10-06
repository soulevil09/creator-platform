// =============================================================================
// Sentry PII scrubber (Session 13, D3) — shared by the API (`@sentry/node`)
// and the web app (`@sentry/nextjs`) as `beforeSend`, `beforeSendTransaction`
// and `beforeBreadcrumb`.
//
// Framework-free on purpose: it works on plain objects shaped like a Sentry
// event, so this package takes no Sentry dependency and the rules are unit-
// tested once. It is the last line, not the only one — both SDKs also run with
// `sendDefaultPii: false` — and it assumes nothing about which fields the SDK
// filled in, so a future SDK adding one is still scrubbed by the generic rules.
//
// What never leaves the process:
//   * request bodies (any of them — a body is a password, a prompt, a message)
//   * cookies, `authorization`, provider signatures (`x-*-signature`,
//     `x-*-sig`), cron secrets (`x-*-cron-secret`), `x-forwarded-for`
//   * query strings and fragments of every URL (signed-URL `X-Amz-*` params,
//     `?token=` verification links)
//   * the user beyond its id (`email`, `ip_address`, `username` dropped)
//   * email-shaped strings anywhere, and the value of any key matching
//     /password|secret|token|key|prompt|payoutEmail/i (storage keys, the anchor
//     prompt, idempotency keys included)
// =============================================================================

export const REDACTED = '[redacted]';

/**
 * What the SDK may collect in the first place — Sentry 11's `dataCollection`,
 * which replaced `sendDefaultPii`. This is the `sendDefaultPii: false`
 * posture, tightened: no user auto-fill, no cookies, no bodies in either
 * direction, no query params, no DB/queue payloads, no stack-frame variables,
 * and request headers on an allowlist. The scrubber below still runs on
 * everything, so a category this misses is caught there.
 */
export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: { allow: ['user-agent', 'content-type', 'content-length', 'accept', 'host'] },
    response: false,
  },
  httpBodies: [] as never[],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  // No source lines around stack frames: a literal in code is not PII, but a
  // fixture or a hard-coded value can be, and the stack trace alone locates it.
  frameContextLines: 0,
};

/** Keys whose value is dropped wherever they appear. */
const SENSITIVE_KEY = /password|secret|token|key|prompt|payoutemail|cookie|authorization/i;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** An absolute URL's query/fragment: `https://x/y?X-Amz-Signature=…` → `https://x/y`. */
const ABSOLUTE_URL_QUERY = /(\b(?:https?|wss?):\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi;

/** A path's query/fragment inside free text: `GET /verify-email?token=…`. */
const PATH_QUERY = /((?:^|[\s"'(])\/[^\s?#"'<>]*)[?#][^\s"'<>)]*/g;

/** Keys that hold a URL in Sentry payloads (request, breadcrumbs, spans). */
const URL_KEYS = new Set(['url', 'to', 'from', 'http.url', 'url.full', 'http.target']);

const MAX_DEPTH = 8;

function isDroppedHeader(name: string): boolean {
  const header = name.toLowerCase();
  return (
    header === 'cookie' ||
    header === 'set-cookie' ||
    header === 'authorization' ||
    header === 'proxy-authorization' ||
    header === 'x-forwarded-for' ||
    header === 'x-real-ip' ||
    header === 'forwarded' ||
    header === 'cf-connecting-ip' ||
    /^x-.+-(signature|sig)$/.test(header) ||
    /cron-secret/.test(header) ||
    SENSITIVE_KEY.test(header)
  );
}

/** Remove the query string and fragment from a URL or path. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Free text: strip URL queries, then redact email addresses. */
export function scrubString(value: string): string {
  return value.replace(ABSOLUTE_URL_QUERY, '$1').replace(PATH_QUERY, '$1').replace(EMAIL, REDACTED);
}

/** Any JSON-ish value: sensitive keys dropped, strings scrubbed, recursively. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
    } else if (URL_KEYS.has(key) && typeof inner === 'string') {
      out[key] = scrubString(stripQuery(inner));
    } else {
      out[key] = scrubValue(inner, depth + 1);
    }
  }
  return out;
}

type Bag = Record<string, unknown>;
const isBag = (value: unknown): value is Bag =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function scrubHeaders(headers: unknown): Bag | undefined {
  if (!isBag(headers)) return undefined;
  const out: Bag = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isDroppedHeader(name)) out[name] = scrubValue(value);
  }
  return out;
}

function scrubRequest(request: unknown): Bag | undefined {
  if (!isBag(request)) return undefined;
  const out: Bag = {};
  // Allowlist: what the request was, never what it carried.
  if (typeof request.method === 'string') out.method = request.method;
  if (typeof request.url === 'string') out.url = scrubString(stripQuery(request.url));
  const headers = scrubHeaders(request.headers);
  if (headers) out.headers = headers;
  // Dropped: data (body), cookies, query_string, env.
  return out;
}

/** A stack frame: local variables and source-context lines scrubbed. */
function scrubFrame(frame: unknown): unknown {
  if (!isBag(frame)) return frame;
  const out: Bag = { ...frame };
  if (frame.vars !== undefined) out.vars = scrubValue(frame.vars);
  if (typeof frame.context_line === 'string') out.context_line = scrubString(frame.context_line);
  for (const key of ['pre_context', 'post_context'] as const) {
    if (Array.isArray(frame[key])) out[key] = scrubValue(frame[key]);
  }
  return out;
}

function scrubException(exception: unknown): unknown {
  if (!isBag(exception) || !Array.isArray(exception.values)) return exception;
  return {
    ...exception,
    values: exception.values.map((entry) => {
      if (!isBag(entry)) return entry;
      const out: Bag = { ...entry };
      if (typeof entry.value === 'string') out.value = scrubString(entry.value);
      if (isBag(entry.stacktrace) && Array.isArray(entry.stacktrace.frames)) {
        out.stacktrace = {
          ...entry.stacktrace,
          frames: entry.stacktrace.frames.map(scrubFrame),
        };
      }
      return out;
    }),
  };
}

/** A breadcrumb: message scrubbed, data scrubbed (URLs lose their query). */
export function scrubSentryBreadcrumb<T extends object>(breadcrumb: T): T {
  const crumb = { ...(breadcrumb as Bag) };
  if (typeof crumb.message === 'string') crumb.message = scrubString(crumb.message);
  if (crumb.data !== undefined) crumb.data = scrubValue(crumb.data);
  return crumb as T;
}

/**
 * An error or transaction event, scrubbed. Returns a new object; the input is
 * not mutated. Used for both `beforeSend` and `beforeSendTransaction`.
 */
export function scrubSentryEvent<T extends object>(event: T): T {
  const out: Bag = { ...(event as Bag) };

  const request = scrubRequest(out.request);
  if (request) out.request = request;
  else delete out.request;

  if (isBag(out.user) && (typeof out.user.id === 'string' || typeof out.user.id === 'number')) {
    out.user = { id: out.user.id };
  } else {
    delete out.user;
  }

  for (const key of ['extra', 'contexts', 'tags', 'data'] as const) {
    if (out[key] !== undefined) out[key] = scrubValue(out[key]);
  }
  if (typeof out.message === 'string') out.message = scrubString(out.message);
  if (isBag(out.logentry)) out.logentry = scrubValue(out.logentry);
  if (typeof out.transaction === 'string') out.transaction = scrubString(out.transaction);
  if (out.exception !== undefined) out.exception = scrubException(out.exception);
  if (Array.isArray(out.breadcrumbs)) {
    out.breadcrumbs = out.breadcrumbs.map((crumb) =>
      isBag(crumb) ? scrubSentryBreadcrumb(crumb) : crumb,
    );
  }
  if (Array.isArray(out.spans)) {
    out.spans = out.spans.map((span) => {
      if (!isBag(span)) return span;
      const scrubbed: Bag = { ...span };
      if (typeof span.description === 'string')
        scrubbed.description = scrubString(span.description);
      if (span.data !== undefined) scrubbed.data = scrubValue(span.data);
      return scrubbed;
    });
  }
  return out as T;
}
