// @vitest-environment node
// The CSP proxy's matcher (Session 12) after Session 13 added the Sentry
// tunnel: documents still get a nonce; `/monitoring` is never touched.
import { describe, expect, it } from 'vitest';
import { config } from '../proxy';

const source = config.matcher[0].source;
const matches = (path: string) => new RegExp(`^${source}$`).test(path);

describe('proxy matcher', () => {
  it('covers documents', () => {
    for (const path of ['/', '/wallet', '/admin/models', '/dev/protected-media']) {
      expect(matches(path), path).toBe(true);
    }
  });

  it('skips static assets, the image endpoint and the Sentry tunnel', () => {
    for (const path of [
      '/_next/static/chunks/a.js',
      '/_next/image',
      '/favicon.ico',
      '/monitoring',
    ]) {
      expect(matches(path), path).toBe(false);
    }
  });
});
