import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CubeSolve Coach — Dal video alla solve',
  description: 'Carica una solve 3×3, ricostruisci lo scramble e leggi le mosse suddivise nelle fasi CFOP.',
  openGraph: {
    title: 'CubeSolve Coach — Dal video alla solve',
    description: 'Carica una solve 3×3, ricostruisci lo scramble e leggi le mosse suddivise nelle fasi CFOP.',
    locale: 'it_IT',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'CubeSolve Coach — Dal video alla solve',
    description: 'Video, scramble ricostruito, replay e lettura CFOP mossa per mossa.',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
