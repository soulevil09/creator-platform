import { APP_NAME, SUPPORTED_CURRENCIES, SUPPORTED_LOCALES } from '@creator-platform/shared';

export default function HomePage() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 640 }}>
      <h1>{APP_NAME}</h1>
      <p>Foundation scaffolded in Session 01. Application features start in Session 02.</p>
      <ul>
        <li>Currencies: {SUPPORTED_CURRENCIES.join(', ')}</li>
        <li>Locales: {SUPPORTED_LOCALES.join(', ')}</li>
      </ul>
    </main>
  );
}
