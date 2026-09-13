'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function ScannerRedirect() {
  useEffect(() => {
    window.location.replace('/');
  }, []);

  return (
    <main className="grid min-h-screen place-items-center bg-[#f6f7fb] px-6 text-center">
      <p className="text-sm text-slate-600">
        Lo scanner ora fa parte della pagina unica. Reindirizzamento a{' '}
        <Link href="/" className="font-bold text-blue-600 underline">CubeSolve Coach</Link>…
      </p>
    </main>
  );
}
