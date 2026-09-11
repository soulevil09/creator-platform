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
import { notFound } from 'next/navigation';
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

export default function ProtectedMediaDemoPage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  return (
    <main style={styles.main}>
      <div style={styles.shell}>
        <h1>ProtectedMedia — demo</h1>
        <p style={styles.muted}>
          Página de desenvolvimento com <strong>assets fictícios</strong>. Experimente: clique com o
          botão direito, tente arrastar, troque de aba ou clique fora da janela.
        </p>
        <p style={styles.muted}>
          Isto é um <strong>dissuasor</strong>, não um controle de segurança: nenhuma página web
          impede um screenshot do sistema operacional, um gravador de tela ou uma câmera externa. A
          proteção real é do servidor (marca d&apos;água forense por visualizador + trilha de
          auditoria); esta camada apenas torna a captura casual mais incômoda e mantém o código de
          rastreio no quadro.
        </p>

        <section style={styles.card} aria-labelledby="demo-image-heading">
          <h2 id="demo-image-heading">Imagem</h2>
          <ProtectedMedia traceCode={DEMO_IMAGE_TRACE} label="Imagem de demonstração protegida">
            <img
              src={PLACEHOLDER_IMAGE}
              alt="Gradiente azul-roxo de demonstração"
              width={480}
              height={300}
              draggable={false}
              style={{ display: 'block', maxWidth: '100%', height: 'auto', borderRadius: 8 }}
            />
          </ProtectedMedia>
        </section>

        <section style={styles.card} aria-labelledby="demo-video-heading">
          <h2 id="demo-video-heading">Vídeo</h2>
          <p style={styles.muted}>
            Sem fonte real — apenas o poster. Em produção, a overlay recebe o <code>traceCode</code>{' '}
            que <code>GET /api/content/:id/serve</code> devolve junto da URL assinada.
          </p>
          <ProtectedMedia traceCode={DEMO_VIDEO_TRACE} label="Vídeo de demonstração protegido">
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
