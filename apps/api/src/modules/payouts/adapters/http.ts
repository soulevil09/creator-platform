// Shared plumbing for the HTTP-backed payout adapters.
//
// Deliberately a sibling of modules/payments/adapters/http.ts rather than a
// shared import: that one is typed to `PaymentProviderName` and throws
// `PaymentProviderError`, and money-in and money-out keep separate error
// taxonomies (a failed charge is a 502 to a waiting subscriber; a failed payout
// rolls a claim back inside a cron run). Collapsing them would mean widening
// both types to a union that neither caller wants to narrow again.
import type { PayoutProviderName } from '@creator-platform/shared';
import { PayoutProviderError } from '../provider.interface.js';

/** Minimal `fetch` shape the adapters depend on. */
export type FetchLike = typeof globalThis.fetch;

/** Abort a provider call rather than stalling the whole payout run. */
export const PAYOUT_TIMEOUT_MS = 15_000;

export interface PostJsonOptions {
  provider: PayoutProviderName;
  fetchImpl: FetchLike;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
}

/**
 * POST JSON and return the parsed response. Any transport failure, non-2xx
 * status, or unparseable body becomes a `PayoutProviderError`. Response bodies
 * are truncated in the error message so a provider echoing back credentials
 * cannot leak through our logs or a `Payout.failureReason`.
 */
export async function postJson<T>({
  provider,
  fetchImpl,
  url,
  headers,
  body,
  timeoutMs = PAYOUT_TIMEOUT_MS,
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
    throw new PayoutProviderError(provider, `${provider} request failed: ${url}`, err);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new PayoutProviderError(
      provider,
      `${provider} responded ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new PayoutProviderError(provider, `${provider} returned a non-JSON body`, err);
  }
}
