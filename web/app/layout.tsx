import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CubeSolve Coach — Ricostruisci lo scramble',
  description: 'Analizza il video o scansiona le sei facce del cubo 3×3 per ricostruire e verificare lo scramble.',
  openGraph: {
    title: 'CubeSolve Coach — Ricostruisci lo scramble',
    description: 'Analizza il video o scansiona le sei facce del cubo 3×3 per ricostruire e verificare lo scramble.',
    locale: 'it_IT',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'CubeSolve Coach — Ricostruisci lo scramble',
    description: 'Video automatico, scansione guidata e scramble 3×3 verificato.',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
