// =============================================================================
// MockAIProvider — deterministic, offline stand-in for Replicate.
//
// Mirrors `MockPaymentProvider` / `MockPayoutProvider` and exists for the same
// two reasons: `AI_PROVIDER=mock` gives a working generation flow with no
// token and no network before the Replicate account is live; and it is what
// proves the abstraction holds — flipping one env var swaps the adapter class
// with no other change anywhere in the codebase.
//
// Returns a fixed 1×1 PNG. Real bytes with a real PNG signature, because the
// service sniffs the output type with `file-type` before storing it, and a
// mock that skipped that path would be testing less than production runs.
// =============================================================================
import type { GenerateImageParams, GeneratedImage, IAIProvider } from '../provider.interface.js';

/** A valid 1×1 transparent PNG. */
export const MOCK_PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export class MockAIProvider implements IAIProvider {
  readonly name = 'mock' as const;

  /** Every call made in this process, for assertions and local debugging. */
  private readonly calls: GenerateImageParams[] = [];
  private seq = 0;

  async generateImage(params: GenerateImageParams): Promise<GeneratedImage> {
    this.calls.push(params);
    this.seq += 1;
    return {
      imageBuffer: Buffer.from(MOCK_PLACEHOLDER_PNG),
      providerJobId: `mock_pred_${this.seq}`,
    };
  }

  /** Calls received so far (tests/local debugging only). */
  getCalls(): readonly GenerateImageParams[] {
    return this.calls;
  }
}
