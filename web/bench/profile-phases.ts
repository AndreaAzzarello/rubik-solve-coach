// Script temporaneo (Fase C, punto 6 della revisione): esegue UNA volta la
// pipeline reale su un video di bench con la strumentazione di
// video-decoder.ts attiva (__profilePhases), stampa una tabella del tempo
// speso per fase. Non misura il punteggio - riusa window.__benchReconstruct
// come run-bench.ts, stessa infrastruttura (dev server + Chrome pinnato).
//
//   node --experimental-strip-types bench/profile-phases.ts IMG_6258

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable } from './chrome-path.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');

async function main() {
  const caseId = process.argv[2] ?? 'IMG_6258';
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = process.env.BENCH_VIDEO_DIR || raw.videoDir;
  const entry = raw.cases.find((c: { id: string }) => c.id === caseId);
  if (!entry) throw new Error(`caso non trovato: ${caseId}`);
  const filePath = path.join(videoDir, entry.video);
  if (!fs.existsSync(filePath)) throw new Error(`video mancante: ${filePath}`);

  const videoServer = await startStaticServer(videoDir);
  const dev = await startDevServer(WEB_ROOT, '[profile]', '/bench');
  const browser = await chromium.launch({
    headless: true,
    executablePath: pinnedChromeExecutable(),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      (window as unknown as { __profilePhases?: boolean }).__profilePhases = true;
    });
    page.on('console', (message) => {
      if (message.type() === 'error') console.log('[profile] console.error:', message.text());
    });
    await page.goto(`${dev.baseUrl}/bench`);
    await page.waitForFunction(() => window.__benchReady === true, { timeout: 30000 });

    const videoUrl = `http://127.0.0.1:${videoServer.port}/${entry.video}`;
    const totalStart = Date.now();
    const result = await page.evaluate(
      (url) => window.__benchReconstruct!(url),
      videoUrl,
    );
    const totalMs = Date.now() - totalStart;

    const timings = await page.evaluate(() => (window as unknown as { __profileTimings?: Record<string, number> }).__profileTimings ?? {});

    console.log(`[profile] ${caseId}: ok=${result.ok} status=${result.status} durationMs(app)=${result.durationMs} totalMs(wall)=${totalMs}`);
    console.log('');
    console.log('fase'.padEnd(32), 'ms'.padStart(10), '%'.padStart(8));
    const sumNamed = Object.values(timings).reduce((a, b) => a + b, 0);
    const rows = Object.entries(timings).sort((a, b) => b[1] - a[1]);
    for (const [bucket, ms] of rows) {
      console.log(bucket.padEnd(32), ms.toFixed(0).padStart(10), `${((ms / totalMs) * 100).toFixed(1)}%`.padStart(8));
    }
    const other = totalMs - sumNamed;
    console.log('altro (overhead, non strumentato)'.padEnd(32), other.toFixed(0).padStart(10), `${((other / totalMs) * 100).toFixed(1)}%`.padStart(8));
    console.log('-'.repeat(52));
    console.log('TOTALE'.padEnd(32), totalMs.toFixed(0).padStart(10), '100.0%'.padStart(8));
  } finally {
    await browser.close();
    await dev.close();
    videoServer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
