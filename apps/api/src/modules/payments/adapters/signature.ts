// Constant-time comparison helpers shared by the webhook signature checks.
//
// `crypto.timingSafeEqual` throws when the two buffers differ in length, which
// would both crash the handler and leak length through the exception — so we
// compare lengths first and always return a boolean.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Compare two encoded digests without an early-exit byte comparison. */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** HMAC of `payload` under `secret`, in the requested encoding. */
export function hmac(
  algorithm: 'sha256' | 'sha512',
  secret: string,
  payload: Buffer | string,
  encoding: 'hex' | 'base64',
): string {
  return createHmac(algorithm, secret).update(payload).digest(encoding);
}

/** Read one header, tolerating Fastify's `string | string[] | undefined`. */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
