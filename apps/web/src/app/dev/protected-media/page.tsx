// Dev-only demo for `ProtectedMedia` (Session 09, D3).
//
// There is no content-viewing page yet, so this small standalone screen (the
// same narrow-slice precedent as /wallet in Session 05) exercises the component
// against PLACEHOLDER assets only — an inline SVG and a source-less <video> —
// so the deterrents can be checked by hand in a browser without a signed URL,
// a storage key, or any real subscriber content. It must stay that way: never
// point this page at the real API.
//
// Not reachable in production: `notFound()` turns it into a 404 there.
//
// Strings come from the active locale's catalog (Session 10) — the page is
// dev-only, but externalising it keeps the "no literal copy" rule uniform.
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ProtectedMedia } from '../../../components/ProtectedMedia';

const PLACEHOLDER_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#0ea5e9"/><stop offset="1" stop-color="#a21caf"/>
      </linearGradient></defs>
      <rect width="480" height="300" fill="url(#g)"/>
      <text x="240" y="158" font-family="sans-serif" font-size="28" fill="#fff" text-anchor="middle">placeholder image</text>
    </svg>`,
  );

const PLACEHOLDER_POSTER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270">
      <rect width="480" height="270" fill="#0f172a"/>
      <text x="240" y="143" font-family="sans-serif" font-size="24" fill="#94a3b8" text-anchor="middle">placeholder video</text>
    </svg>`,
  );

/** Fixed, obviously fake codes — the real ones come from the API per serve. */
const DEMO_IMAGE_TRACE = 'DEMO2IMG';
const DEMO_VIDEO_TRACE = 'DEMO2VID';

const styles = {
  main: {
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    minHeight: '100vh',
    padding: '2rem 1.5rem 4rem',
    background: 'linear-gradient(160deg, #0f172a 0%, #1e293b 100%)',
    color: '#f8fafc',
  },
  shell: { maxWidth: 720, margin: '0 auto' },
  card: {
    border: '1px solid #334155',
    borderRadius: 12,
    padding: '1.25rem',
    background: 'rgba(148, 163, 184, 0.08)',
    marginTop: '1.5rem',
  },
  muted: { color: '#94a3b8', fontSize: '0.9rem' },
} as const;

/** Inline markup the demo copy is allowed to use — the catalog names the tags. */
const rich = {
  strong: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
  code: (chunks: React.ReactNode) => <code>{chunks}</code>,
};

export default async function ProtectedMediaDemoPage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  const t = await getTranslations('protectedMediaDemo');

  return (
    <main style={styles.main}>
      <div style={styles.shell}>
        <h1>{t('title')}</h1>
        <p style={styles.muted}>{t.rich('intro', rich)}</p>
        <p style={styles.muted}>{t.rich('disclaimer', rich)}</p>

        <section style={styles.card} aria-labelledby="demo-image-heading">
          <h2 id="demo-image-heading">{t('imageHeading')}</h2>
          <ProtectedMedia traceCode={DEMO_IMAGE_TRACE} label={t('imageLabel')}>
            <img
              src={PLACEHOLDER_IMAGE}
              alt={t('imageAlt')}
              width={480}
              height={300}
              draggable={false}
              style={{ display: 'block', maxWidth: '100%', height: 'auto', borderRadius: 8 }}
            />
          </ProtectedMedia>
        </section>

        <section style={styles.card} aria-labelledby="demo-video-heading">
          <h2 id="demo-video-heading">{t('videoHeading')}</h2>
          <p style={styles.muted}>{t.rich('videoNote', rich)}</p>
          <ProtectedMedia traceCode={DEMO_VIDEO_TRACE} label={t('videoLabel')}>
            {/* `muted`: there is no audio track to caption on a source-less placeholder. */}
            <video
              controls
              muted
              playsInline
              poster={PLACEHOLDER_POSTER}
              width={480}
              height={270}
              style={{ display: 'block', maxWidth: '100%', height: 'auto', borderRadius: 8 }}
            />
          </ProtectedMedia>
        </section>
      </div>
    </main>
  );
}
