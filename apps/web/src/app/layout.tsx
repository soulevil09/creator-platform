import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { LocaleSwitcher } from '../components/LocaleSwitcher';

// Metadata is rendered per request in the resolved locale (Session 10) — a
// static `metadata` export could only ever be in one language.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata');
  return { title: t('title'), description: t('description') };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Resolved once per request in src/i18n/request.ts (cookie → Accept-Language
  // → default). `<html lang>` follows it so assistive tech reads the page in
  // the right language, and `messages` is the ACTIVE locale's catalog only —
  // that is all the client provider ships to the browser.
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <LocaleSwitcher />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
