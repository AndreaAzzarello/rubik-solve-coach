import type { Metadata, Viewport } from 'next';
import { CONNECT_ONLY_CSP } from '../lib/csp';
import { SOURCE_CODE_LABEL, SOURCE_CODE_URL } from '../lib/legal';
import './globals.css';

export const metadata: Metadata = {
  title: 'CubeSolve Coach — Ricostruisci lo scramble',
  description: 'Analizza il video o scansiona le sei facce del cubo 3×3 per ricostruire e verificare lo scramble.',
  manifest: '/manifest.json',
  icons: { icon: '/favicon.svg' },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'CubeSolve Coach',
  },
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

export const viewport: Viewport = {
  themeColor: '#2563eb',
  colorScheme: 'light',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="it">
      <head>
        <meta httpEquiv="Content-Security-Policy" content={CONNECT_ONLY_CSP} />
      </head>
      <body>
        {children}
        <footer className="px-4 pb-6 pt-2 text-center text-sm text-slate-600 sm:px-8 lg:px-12">
          <a
            href={SOURCE_CODE_URL}
            className="inline-block rounded px-2 py-1.5 underline underline-offset-4 hover:text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            {SOURCE_CODE_LABEL}
          </a>
        </footer>
      </body>
    </html>
  );
}
