// Cartella dei video del banco di prova. I video restano locali (fuori dal
// repo): il percorso non e' tracciato in nessun file, si imposta con la
// variabile d'ambiente BENCH_VIDEO_DIR.

import path from 'node:path';

export function requireVideoDir(configured?: string): string {
  const dir = process.env.BENCH_VIDEO_DIR || configured;
  if (!dir) {
    throw new Error(
      'Cartella dei video non definita: imposta la variabile d\'ambiente BENCH_VIDEO_DIR '
        + '(percorso locale con i video del banco di prova; non va nel repo).',
    );
  }
  return path.resolve(dir);
}
