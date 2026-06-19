import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { APP_NAME } from '@creator-platform/shared';

export const metadata: Metadata = {
  title: APP_NAME,
  description: 'Content monetization with AI-powered image personalization.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
