// =============================================================================
// Server-side image processing (Session 04).
//
// Why `sharp`: it is the de-facto standard for image work in Node — a libvips
// binding that decodes/encodes JPEG/PNG/WebP fast and supports SVG compositing,
// which we use to burn a per-user watermark onto delivered images.
//
// Why an interface (not `import sharp` everywhere): the rest of the app depends
// only on `ImageProcessor`, exactly like `StorageClient` and `Emailer`. Tests
// inject an in-memory fake, so the watermark/serve path is exercised without
// loading sharp's native binary in CI. The sharp-backed implementation is the
// only place that touches the library.
// =============================================================================
import sharp from 'sharp';

/** A sharp processing pipeline (sharp's default export is callable + namespace). */
type SharpPipeline = ReturnType<typeof sharp>;

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ImageProcessor {
  /** Detect pixel dimensions of an encoded image. Returns nulls if unknown. */
  getDimensions(buffer: Buffer): Promise<{ width: number | null; height: number | null }>;
  /**
   * Composite a semi-transparent text watermark onto an image and return the
   * re-encoded bytes in `mimeType`. The watermark sits bottom-right with white
   * text and a dark drop shadow (SVG overlay). Never mutates the source bytes.
   */
  watermark(buffer: Buffer, text: string, mimeType: string): Promise<Buffer>;
}

/** Cap the longest processed edge so watermarking stays fast on huge uploads. */
const MAX_WATERMARK_EDGE = 2048;

/** XML-escape watermark text so an email/display name can't break the SVG. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Re-encode a sharp pipeline to the requested delivery MIME type. */
function encodeAs(pipeline: SharpPipeline, mimeType: string): SharpPipeline {
  switch (mimeType) {
    case 'image/png':
      return pipeline.png();
    case 'image/webp':
      return pipeline.webp();
    case 'image/jpeg':
    default:
      return pipeline.jpeg();
  }
}

/**
 * Memory bounds for the production box (Session 13): one vCPU, 1 GB RAM (2 GB
 * at launch), the API container capped at 448 MiB.
 *
 *   * libvips threads per image = 1. More threads cannot run in parallel on one
 *     vCPU anyway, and each one holds its own tile buffers.
 *   * sharp's operation cache off: it keeps decoded images around to speed up
 *     repeat work, which per-viewer watermarking never repeats.
 *   * at most 2 watermarks in flight; the rest queue. A 2048-px RGBA working
 *     image is ~16 MiB, so two in flight plus encode buffers stay well under
 *     ~100 MiB of native memory, leaving the heap its 256 MiB.
 *   * decompression-bomb guard: inputs above 50 megapixels are refused
 *     (sharp's default is 268 MP, i.e. a 1 GiB decode).
 */
const SHARP_THREADS = 1;
const MAX_CONCURRENT_WATERMARKS = 2;
const MAX_INPUT_PIXELS = 50_000_000;

/** A minimal FIFO semaphore: at most `limit` tasks run at once. */
function createLimiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export function createSharpImageProcessor(): ImageProcessor {
  sharp.concurrency(SHARP_THREADS);
  sharp.cache(false);
  const limit = createLimiter(MAX_CONCURRENT_WATERMARKS);

  return {
    async getDimensions(buffer) {
      const { width, height } = await sharp(buffer).metadata();
      return { width: width ?? null, height: height ?? null };
    },

    watermark(buffer, text, mimeType) {
      return limit(() => renderWatermark(buffer, text, mimeType));
    },
  };
}

async function renderWatermark(buffer: Buffer, text: string, mimeType: string): Promise<Buffer> {
  // Resize down (never up) so the SVG overlay and re-encode stay under the
  // ~500ms budget from the session perf notes for very large images.
  //
  // The resize is materialised (raw pixels) before the overlay is sized:
  // `metadata()` on a pipeline reports the INPUT dimensions, not the resized
  // ones, so an overlay built from it is larger than the output for any image
  // over MAX_WATERMARK_EDGE and the composite throws (Session 13 fix — before
  // it, serving any photo larger than 2048 px failed with a 500).
  const { data, info } = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate() // honour EXIF orientation before measuring
    .resize({
      width: MAX_WATERMARK_EDGE,
      height: MAX_WATERMARK_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const base = sharp(data, { raw: { width, height, channels } });

  // Scale text to the image; clamp so tiny thumbnails stay legible and huge
  // images don't get a giant stamp. Padding keeps it off the very edge.
  const fontSize = Math.max(14, Math.round(width * 0.03));
  const padding = Math.round(fontSize * 0.75);
  const label = escapeXml(text);

  // White text at 40% opacity with a dark blurred drop shadow for contrast
  // over light backgrounds. Anchored bottom-right via text-anchor:end.
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000000" flood-opacity="0.8"/>
    </filter>
  </defs>
  <text x="${width - padding}" y="${height - padding}"
        font-family="sans-serif" font-size="${fontSize}" font-weight="600"
        text-anchor="end" fill="#ffffff" fill-opacity="0.4" filter="url(#shadow)">${label}</text>
</svg>`,
    'utf8',
  );

  const composited = base.composite([{ input: svg, top: 0, left: 0 }]);
  return encodeAs(composited, mimeType).toBuffer();
}
