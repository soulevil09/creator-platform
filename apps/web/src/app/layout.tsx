import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'VisorFans — Plataforma de monetização para criadores de conteúdo',
  description:
    'Atendemos criadores digitais (modelos, influenciadores e artistas) e seus assinantes. Vendemos assinaturas mensais e pacotes de créditos digitais pelo nosso portal web.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
