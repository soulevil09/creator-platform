// Type-safe message keys for next-intl (Session 10): `t('wallet.title')` is a
// compile error when the key is missing from `en.json`, and `useLocale()` is
// narrowed to the platform's `Locale` union. The pt-BR catalog is held to the
// same shape by the parity test in `catalog.test.ts`.
import type en from '../../messages/en.json';
import type { Locale as PlatformLocale } from '@creator-platform/shared';

declare module 'next-intl' {
  interface AppConfig {
    Locale: PlatformLocale;
    Messages: typeof en;
  }
}
