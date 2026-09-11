// =============================================================================
// ReplicateAdapter — hosted image generation via Replicate's predictions API.
//
// ── Model choice: TencentARC PhotoMaker (SDXL-based), pinned by version hash ──
// Text alone cannot anchor a specific person's likeness: a pure text-to-image
// SDXL call drifts to a generic face every run, which fails the brief's
// "prevents drift" requirement outright. PhotoMaker is an SDXL pipeline that
// conditions generation on stacked ID embeddings extracted from one to four
// reference photos of the same person, which is exactly the input this
// platform holds (`ReferenceImage`, up to 10 per model, Session 03). Compared
// with plain SDXL img2img (which preserves a *composition*, not an identity)
// or a single-image IP-Adapter face variant, it takes several references and
// is built for identity-preserving personalization rather than style transfer.
// It also exposes `disable_safety_checker`, which a consented adult platform
// needs — and which is why the age/minor gate is enforced on OUR side
// (modules/generation/safety.ts) before a prompt ever reaches this file.
//
// ⚠️ WIRE FORMAT IS PROVISIONAL — SEE CLAUDE.md OPEN ITEMS.
// No Replicate account is live yet, so this adapter is written against the
// publicly documented predictions API and exercised only against nock. The
// version hash, the input field names (`input_image`…`input_image4`,
// `prompt` with PhotoMaker's `img` trigger word, `negative_prompt`,
// `disable_safety_checker`), the `Authorization: Bearer` scheme, the polling
// contract (`status` ∈ starting|processing|succeeded|failed|canceled) and the
// output shape (an array of image URLs) must all be re-verified against a
// live prediction before production. Everything provisional is confined to
// this file, behind `IAIProvider` — the same posture as Woovi, NOWPayments
// and Paxum before their accounts were approved.
//
// ── Polling ──
// Replicate predictions are asynchronous: create, then poll until terminal.
// The interval starts at 1 s and grows ×1.5 to a 5 s cap — a warm run finishes
// in 10–20 s (so early polls should be frequent) while a cold boot can take
// 30–60 s (so later polls should not hammer the API). The whole thing —
// create, polls, output download — shares one wall-clock budget
// (`GENERATION_TIMEOUT_MS`, default 90 s). Past it the prediction is cancelled
// (best effort) and the call fails closed; the caller refunds.
// =============================================================================
import {
  AIProviderError,
  type GenerateImageParams,
  type GeneratedImage,
  type IAIProvider,
} from '../provider.interface.js';

/** Minimal `fetch` shape the adapter depends on. */
export type FetchLike = typeof globalThis.fetch;

/**
 * PROVISIONAL — `tencentarc/photomaker` version hash as published on Replicate
 * at the time of writing. Pinned, never `latest`: a model update must be a
 * deliberate change here, not a silent behaviour change in production.
 */
export const REPLICATE_MODEL_VERSION =
  'ddfc2b08d209f9fa8c1eca692712918bd449f695dabb4a958da31802a9570fe4';

export const REPLICATE_API_URL = 'https://api.replicate.com';

/** PhotoMaker accepts at most four reference images. */
const MAX_REFERENCE_IMAGES = 4;

/** PROVISIONAL — prediction states. */
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

/** Per-request cap so one stuck HTTP call cannot eat the whole budget. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Fixed negative prompt. A belt-and-braces layer under the platform's own
 * safety gate — the gate rejects the prompt before credits are touched; this
 * steers the model away from the same content if a phrasing slips past the
 * word lists. It is not the control, the gate is.
 */
const NEGATIVE_PROMPT =
  'child, minor, teenager, underage, childlike, school uniform, ' +
  'deformed, disfigured, extra limbs, bad anatomy, blurry, lowres, watermark, text';

interface ReplicatePrediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
}

export interface ReplicateAdapterConfig {
  apiToken: string;
  apiUrl?: string;
  modelVersion?: string;
  /** Whole-call wall-clock budget (create + polls + download). */
  timeoutMs?: number;
  /** First poll delay; grows ×1.5 per poll up to `maxPollIntervalMs`. */
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  fetchImpl?: FetchLike;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ReplicateAdapter implements IAIProvider {
  readonly name = 'replicate' as const;

  private readonly apiUrl: string;
  private readonly modelVersion: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxPollIntervalMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: ReplicateAdapterConfig) {
    this.apiUrl = (config.apiUrl ?? REPLICATE_API_URL).replace(/\/+$/, '');
    this.modelVersion = config.modelVersion ?? REPLICATE_MODEL_VERSION;
    this.timeoutMs = config.timeoutMs ?? 90_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 1_000;
    this.maxPollIntervalMs = config.maxPollIntervalMs ?? 5_000;
    // Bind late so a stubbed `globalThis.fetch` (nock) is resolved at call
    // time rather than captured at construction.
    this.fetchImpl = config.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  async generateImage(params: GenerateImageParams): Promise<GeneratedImage> {
    const deadline = Date.now() + this.timeoutMs;
    const remaining = () => deadline - Date.now();

    if (params.referenceImageUrls.length === 0) {
      throw new AIProviderError(this.name, 'failed', 'Replicate: no reference images to anchor on');
    }

    // ── 1. Create the prediction ─────────────────────────────────────────────
    const created = await this.request<ReplicatePrediction>(
      'POST',
      '/v1/predictions',
      remaining(),
      {
        version: this.modelVersion,
        input: this.buildInput(params),
      },
    );
    const id = created.id;
    if (!id) {
      throw new AIProviderError(this.name, 'invalid_response', 'Replicate: prediction had no id');
    }

    // ── 2. Poll until terminal, or until the budget runs out ─────────────────
    // Any timeout while the prediction is still running — at the loop head or
    // inside a poll request — cancels it before failing closed, so a slow run
    // does not keep billing after we have already refunded the subscriber.
    let prediction = created;
    let delay = this.pollIntervalMs;
    try {
      while (!TERMINAL_STATUSES.has(prediction.status ?? '')) {
        await sleep(Math.min(delay, Math.max(remaining(), 0)));
        if (remaining() <= 0) {
          throw new AIProviderError(
            this.name,
            'timeout',
            `Replicate: prediction ${id} exceeded the ${this.timeoutMs}ms budget`,
          );
        }
        delay = Math.min(Math.round(delay * 1.5), this.maxPollIntervalMs);
        prediction = await this.request<ReplicatePrediction>(
          'GET',
          `/v1/predictions/${encodeURIComponent(id)}`,
          remaining(),
        );
      }
    } catch (err) {
      if (err instanceof AIProviderError && err.reason === 'timeout') {
        await this.cancel(id);
      }
      throw err;
    }

    if (prediction.status !== 'succeeded') {
      // The provider's `error` string goes in `cause`, never in the message:
      // Replicate echoes the prediction input back, and nothing that could
      // carry the anchor prompt may reach a log line or a job row.
      throw new AIProviderError(
        this.name,
        'failed',
        `Replicate: prediction ${id} ended ${prediction.status ?? 'unknown'}`,
        prediction.error,
      );
    }

    // ── 3. Download the first output ─────────────────────────────────────────
    const outputUrl = firstOutputUrl(prediction.output);
    if (!outputUrl) {
      throw new AIProviderError(
        this.name,
        'invalid_response',
        `Replicate: prediction ${id} succeeded with no output URL`,
      );
    }
    const imageBuffer = await this.download(outputUrl, remaining());

    return { imageBuffer, providerJobId: id };
  }

  /**
   * PROVISIONAL — PhotoMaker input. The `img` token after the class word is
   * the model's trigger for "this is the person in the reference images"; the
   * anchor prompt follows the scene so the identity lock is the last thing the
   * text encoder reads.
   */
  private buildInput(params: GenerateImageParams): Record<string, unknown> {
    const scene = params.userPrompt?.trim() ? `, ${params.userPrompt.trim()}` : '';
    const prompt = `a photo of a person img${scene}. ${params.anchorPrompt}`;

    const references = params.referenceImageUrls.slice(0, MAX_REFERENCE_IMAGES);
    const input: Record<string, unknown> = {
      prompt,
      negative_prompt: NEGATIVE_PROMPT,
      input_image: references[0],
      num_outputs: 1,
      num_steps: 30,
      style_name: 'Photographic (Default)',
      style_strength_ratio: 20,
      guidance_scale: 5,
      // Consented adult platform: the provider's nudity filter is off. The
      // age/minor filter is this platform's own gate and stays active whatever
      // this flag does — see modules/generation/safety.ts.
      disable_safety_checker: true,
    };
    references.slice(1).forEach((url, index) => {
      input[`input_image${index + 2}`] = url;
    });
    return input;
  }

  /** Best-effort cancel on timeout; a failure here changes nothing for the caller. */
  private async cancel(id: string): Promise<void> {
    try {
      await this.request('POST', `/v1/predictions/${encodeURIComponent(id)}/cancel`, 5_000);
    } catch {
      // The prediction may finish on its own; we have already failed closed.
    }
  }

  /**
   * JSON round trip against the predictions API. Non-2xx and transport
   * failures become `AIProviderError`s carrying the status code only — the
   * body is never quoted, because Replicate echoes the input (our anchor
   * prompt) back in every prediction payload.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    budgetMs: number,
    body?: unknown,
  ): Promise<T> {
    const response = await this.send(`${this.apiUrl}${path}`, budgetMs, {
      method,
      headers: {
        // PROVISIONAL — Replicate's documented token scheme. The token is read
        // from env and never logged, echoed into an error, or persisted.
        authorization: `Bearer ${this.config.apiToken}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      throw new AIProviderError(
        this.name,
        'http_error',
        `Replicate responded ${response.status} to ${method} ${path}`,
      );
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new AIProviderError(
        this.name,
        'invalid_response',
        'Replicate returned a non-JSON body',
        err,
      );
    }
  }

  private async download(url: string, budgetMs: number): Promise<Buffer> {
    const response = await this.send(url, budgetMs, { method: 'GET' });
    if (!response.ok) {
      throw new AIProviderError(
        this.name,
        'http_error',
        `Replicate output download responded ${response.status}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /** One HTTP call bounded by the smaller of the per-request cap and what is left of the budget. */
  private async send(url: string, budgetMs: number, init: RequestInit): Promise<Response> {
    if (budgetMs <= 0) {
      throw new AIProviderError(this.name, 'timeout', 'Replicate: generation budget exhausted');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, budgetMs));
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      const reason = controller.signal.aborted ? 'timeout' : 'http_error';
      throw new AIProviderError(this.name, reason, `Replicate request failed (${reason})`, err);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Replicate returns either one URL or an array of them; take the first string. */
function firstOutputUrl(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const first = output.find((item) => typeof item === 'string');
    return typeof first === 'string' ? first : null;
  }
  return null;
}
