// =============================================================================
// IAIProvider — the seam every image-generation backend sits behind.
//
// The generation service calls ONLY `generateImage`. Nothing outside
// `adapters/` may know that Replicate speaks `version` + `input`, polls a
// prediction URL, or hands back an output URL to download; swapping the
// provider is one adapter class plus one env var (`AI_PROVIDER`), never a
// change here or in the service layer. Same shape as `IPaymentProvider`
// (Session 05) and `IPayoutProvider` (Session 06).
//
// One method, because there is one job: turn a hidden likeness anchor, the
// subscriber's scene text and the model's reference images into bytes. Every
// failure — timeout, HTTP error, provider-side rejection, unusable output —
// is thrown as `AIProviderError`, so the caller decides "refund and mark
// FAILED" without learning the provider's error vocabulary.
// =============================================================================

/** Adapter identities. Not persisted (GenerationJob has no provider column). */
export type AIProviderName = 'replicate' | 'mock';

export interface GenerateImageParams {
  /**
   * The hidden, server-built likeness anchor (modules/generation/anchor.ts).
   * Adapters may compose it into a provider prompt but must never log it in
   * full above debug level, echo it in an error, or return it.
   */
  anchorPrompt: string;
  /**
   * The scene half of the prompt: the subscriber's own text for CUSTOM mode,
   * the catalog fragment for PRESET mode. Null when there is nothing beyond
   * the anchor.
   */
  userPrompt: string | null;
  /** Short-TTL signed URLs of the model's `ReferenceImage`s, in upload order. */
  referenceImageUrls: string[];
}

export interface GeneratedImage {
  /** Encoded image bytes (PNG/JPEG/WebP). The caller sniffs the type. */
  imageBuffer: Buffer;
  /** Provider-side prediction/job id, persisted for audit and debugging only. */
  providerJobId: string;
}

export interface IAIProvider {
  readonly name: AIProviderName;
  generateImage(params: GenerateImageParams): Promise<GeneratedImage>;
}

/**
 * Why a generation did not produce an image, flattened to what the service
 * acts on. `timeout` and `failed` both refund; the distinction is kept for the
 * job's `errorMessage` and the audit trail.
 */
export type AIProviderFailureReason = 'timeout' | 'failed' | 'http_error' | 'invalid_response';

/** Thrown when a provider call fails; surfaced to the client as 502. */
export class AIProviderError extends Error {
  constructor(
    readonly provider: AIProviderName,
    readonly reason: AIProviderFailureReason,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}

/** Thrown at boot when `AI_PROVIDER` names an adapter we don't have. */
export class AIProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIProviderConfigError';
  }
}
