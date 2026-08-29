import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Cube Video Scanner',
  description: 'Analizza un video del cubo 3×3 e ricostruisce lo stato iniziale.',
  manifest: '/scanner/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Cube Scanner',
  },
};

export const viewport: Viewport = {
  themeColor: '#07111f',
  colorScheme: 'dark',
};

export default function ScannerLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
