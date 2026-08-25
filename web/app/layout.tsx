import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CubeSolve Coach — Analisi della solve',
  description: 'Analizza le mosse di una risoluzione 3×3, le fasi CFOP e lo scramble ricostruito.',
  openGraph: {
    title: 'CubeSolve Coach — Analisi della solve',
    description: 'Analizza le mosse di una risoluzione 3×3, le fasi CFOP e lo scramble ricostruito.',
    locale: 'it_IT',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'CubeSolve Coach — Analisi della solve',
    description: 'Replay mossa per mossa, Cross configurabile e lettura CFOP.',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
