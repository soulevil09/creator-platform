// Shared plumbing for the HTTP-backed payment adapters.
//
// Uses the platform `fetch` (Node 18+ undici) rather than an HTTP client
// dependency: one less package to keep patched, and it is what `nock@14`
// intercepts in the adapter tests. The `fetchImpl` seam exists so an adapter
// can be handed a stub directly when a test wants call-level assertions
// instead of wire-level interception.
import { PaymentProviderError } from '../provider.interface.js';
import type { PaymentProviderName } from '@creator-platform/shared';

/** Minimal `fetch` shape the adapters depend on. */
export type FetchLike = typeof globalThis.fetch;

/** Abort a provider call rather than holding a checkout request open. */
export const PROVIDER_TIMEOUT_MS = 10_000;

export interface PostJsonOptions {
  provider: PaymentProviderName;
  fetchImpl: FetchLike;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
}

/**
 * POST JSON and return the parsed response. Any transport failure, non-2xx
 * status, or unparseable body becomes a `PaymentProviderError` — the checkout
 * service turns that into a 502 and marks the transaction FAILED. Response
 * bodies are truncated in the error message so a provider echoing back
 * credentials cannot bloat or leak through our logs.
 */
export async function postJson<T>({
  provider,
  fetchImpl,
  url,
  headers,
  body,
  timeoutMs = PROVIDER_TIMEOUT_MS,
}: PostJsonOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new PaymentProviderError(provider, `${provider} request failed: ${url}`, err);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new PaymentProviderError(
      provider,
      `${provider} responded ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new PaymentProviderError(provider, `${provider} returned a non-JSON body`, err);
  }
}
