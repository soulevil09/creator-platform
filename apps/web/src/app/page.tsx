import { getTranslations } from 'next-intl/server';

export default async function HomePage() {
  // Server component: translated on the server in the request's locale, so
  // the first HTML byte is already in the right language.
  const t = await getTranslations('home');
  const common = await getTranslations('common');

  return (
    <main
      style={{
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        background: 'linear-gradient(160deg, #0f172a 0%, #1e293b 100%)',
        color: '#f8fafc',
        textAlign: 'center',
      }}
    >
      <section style={{ maxWidth: 640 }}>
        <h1
          style={{
            fontSize: '3rem',
            fontWeight: 700,
            margin: 0,
            letterSpacing: '-0.02em',
          }}
        >
          {common('brand')}
        </h1>

        <p
          style={{
            fontSize: '1.25rem',
            color: '#cbd5e1',
            marginTop: '1rem',
            marginBottom: '2rem',
          }}
        >
          {t('tagline')}
        </p>

        <p
          style={{
            fontSize: '1.05rem',
            lineHeight: 1.7,
            color: '#e2e8f0',
            margin: 0,
          }}
        >
          {t('description')}
        </p>

        <div
          style={{
            display: 'inline-block',
            marginTop: '2.5rem',
            padding: '0.6rem 1.4rem',
            borderRadius: '9999px',
            border: '1px solid #334155',
            background: 'rgba(148, 163, 184, 0.1)',
            fontSize: '0.95rem',
            color: '#94a3b8',
          }}
        >
          {t('comingSoon')}
        </div>
      </section>

      <footer
        style={{
          marginTop: '3rem',
          fontSize: '0.85rem',
          color: '#64748b',
        }}
      >
        {/* As a string: ICU would group a number argument ("2.026" in pt-BR). */}
        {t('copyright', { year: String(new Date().getFullYear()), brand: common('brand') })}
      </footer>
    </main>
  );
}
