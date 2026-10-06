// =============================================================================
// Real-sharp watermark check (Session 13) — run in CI after the build:
//
//   pnpm --filter @creator-platform/api exec tsx scripts/check-watermark.ts
//
// The unit suite injects a fake ImageProcessor and never loads sharp's native
// binary (Session 04 decision). That is how a pre-existing defect went
// unnoticed: the overlay was sized from the INPUT dimensions, so serving any
// image larger than 2048 px threw ("Image to composite must have same
// dimensions or smaller"). This script drives the real processor:
//
//   1. a 3000×2000 JPEG          → succeeds, output 2048×1365
//   2. a 400×300 transparent PNG → succeeds, alpha kept, size unchanged
//   3. a 300×200 JPEG with EXIF orientation 6 + GPS tags
//                                → rotated to 200×300, and the output carries
//                                  NO EXIF / GPS / orientation (served images
//                                  must never leak where a photo was taken)
//   4. a 64 MP PNG               → refused (decompression-bomb guard)
// =============================================================================
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createSharpImageProcessor } from '../src/lib/image.js';

const processor = createSharpImageProcessor();
const LABEL = 'VF·TRACE-1234';

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`[check-watermark] ok   ${name}`);
  } catch (err) {
    console.error(`[check-watermark] FAIL ${name}: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

await check('3000px JPEG is downscaled to the 2048px edge', async () => {
  const input = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: '#777' },
  })
    .jpeg()
    .toBuffer();
  const meta = await sharp(await processor.watermark(input, LABEL, 'image/jpeg')).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 2048);
  assert.equal(meta.height, 1365);
});

await check('transparent PNG keeps its size and alpha', async () => {
  const input = await sharp({
    create: { width: 400, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.1 } },
  })
    .png()
    .toBuffer();
  const meta = await sharp(await processor.watermark(input, LABEL, 'image/png')).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 300);
  assert.equal(meta.hasAlpha, true);
});

await check('EXIF-rotated JPEG is rotated, and EXIF/GPS is stripped', async () => {
  const input = await sharp({
    create: { width: 300, height: 200, channels: 3, background: '#345' },
  })
    .jpeg()
    .withExif({
      IFD0: { Make: 'TestCam', Model: 'Leaky' },
      IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '23/1 33/1 0/1' },
    })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const inMeta = await sharp(input).metadata();
  assert.equal(inMeta.orientation, 6, 'fixture must carry an orientation');
  assert.ok(inMeta.exif, 'fixture must carry EXIF');

  const out = await processor.watermark(input, LABEL, 'image/jpeg');
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 200);
  assert.equal(meta.height, 300);
  assert.equal(meta.exif, undefined, 'output must carry no EXIF block');
  assert.equal(meta.orientation, undefined, 'output must carry no orientation tag');
  assert.ok(!out.includes(Buffer.from('TestCam')), 'camera make leaked');
  assert.ok(!out.includes(Buffer.from('GPS')), 'GPS marker leaked');
});

await check('a 64-megapixel input is refused', async () => {
  const bomb = await sharp({
    create: { width: 8000, height: 8000, channels: 3, background: '#000' },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await assert.rejects(processor.watermark(bomb, LABEL, 'image/png'), /pixel limit/);
});
