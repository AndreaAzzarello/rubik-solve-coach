// Risolve il percorso dell'eseguibile Chrome for Testing pinnato dal bench.
// La versione e' in bench/chrome-version.txt e viene scaricata da
// `pnpm bench:setup` (bench/setup-chrome.mjs) nella cache locale gitignored.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeExecutablePath, Browser } from '@puppeteer/browsers';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CHROME_CACHE_DIR = path.join(HERE, '.cache', 'chrome');
export const CHROME_BUILD_ID = fs
  .readFileSync(path.join(HERE, 'chrome-version.txt'), 'utf8')
  .trim();

/**
 * Percorso dell'eseguibile Chrome for Testing pinnato. Un override esplicito e'
 * possibile con BENCH_CHROME_PATH (sconsigliato: rompe la riproducibilita').
 */
export function pinnedChromeExecutable(): string {
  const override = process.env.BENCH_CHROME_PATH;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`BENCH_CHROME_PATH punta a un file inesistente: ${override}`);
    }
    return override;
  }
  const exe = computeExecutablePath({
    browser: Browser.CHROME,
    buildId: CHROME_BUILD_ID,
    cacheDir: CHROME_CACHE_DIR,
  });
  if (!fs.existsSync(exe)) {
    throw new Error(
      `Chrome for Testing ${CHROME_BUILD_ID} non installato in ${CHROME_CACHE_DIR}.\n`
      + 'Esegui prima:  pnpm bench:setup',
    );
  }
  return exe;
}
