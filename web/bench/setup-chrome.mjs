// Scarica UNA VOLTA una versione fissa di Chrome for Testing nella cache locale
// del bench (bench/.cache/chrome, gitignored).
//
// Perche' Chrome for Testing e non il Chromium di Playwright: CfT include i
// codec proprietari (H.264/AAC) necessari a decodificare gli .mp4 del banco di
// prova. Perche' pinnato: la versione del browser sposta il punteggio (decoder,
// stack GL). La versione e' in bench/chrome-version.txt; cambiarla e' una scelta
// esplicita che obbliga a ri-baselineare il bench.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  install,
  computeExecutablePath,
  detectBrowserPlatform,
  Browser,
} from '@puppeteer/browsers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, '.cache', 'chrome');
const BUILD_ID = fs.readFileSync(path.join(HERE, 'chrome-version.txt'), 'utf8').trim();

const platform = detectBrowserPlatform();
const exe = computeExecutablePath({ browser: Browser.CHROME, buildId: BUILD_ID, cacheDir: CACHE_DIR });

if (fs.existsSync(exe)) {
  console.log(`[setup-chrome] gia' presente: Chrome for Testing ${BUILD_ID}`);
  console.log(`[setup-chrome] ${exe}`);
} else {
  console.log(`[setup-chrome] scarico Chrome for Testing ${BUILD_ID} (${platform}) ...`);
  await install({ browser: Browser.CHROME, buildId: BUILD_ID, cacheDir: CACHE_DIR });
  const ready = computeExecutablePath({ browser: Browser.CHROME, buildId: BUILD_ID, cacheDir: CACHE_DIR });
  console.log(`[setup-chrome] pronto: ${ready}`);
}
