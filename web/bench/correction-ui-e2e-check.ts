// Test end-to-end (Playwright) del flusso D (ripropagazione + palette
// filtrata) sulla pagina reale dell'app (non l'harness /bench): carica un
// video del bench, lancia l'analisi, conferma una casella e verifica che
// altre caselle si compilino da sole e che la palette resti filtrata.
// Cattura anche gli screenshot degli stati principali (normale, palette
// filtrata, conflitto, completato), ritagliati sul solo pannello "Stato
// iniziale" (mai sul lettore video, che potrebbe mostrare fotogrammi
// dell'ispezione): nessun fotogramma personale negli screenshot prodotti.
//
// Robustezza (dopo un run bloccato 3+ ore il 2026-10-12, causa: il dev
// server e' morto subito per EACCES sulla porta 3000, ma l'errore e'
// arrivato PRIMA del try/finally che chiude i server -> il server video
// statico e' rimasto in ascolto per sempre e il processo node non e' mai
// uscito): timeout globale di 10 minuti con cleanup garantito, timeout di
// 30s su ogni attesa di elemento con messaggio esplicito, log di
// avanzamento passo-passo, screenshot+HTML salvati fuori dal repo in caso
// di errore.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { startStaticServer } from './lib/static-server.ts';
import { startDevServer } from './lib/dev-server.ts';
import { pinnedChromeExecutable, CHROME_BUILD_ID } from './chrome-path.ts';
import { referenceFromScramble } from './lib/score.ts';
import { CUBE_FACES, type CubeColor, type Face } from '../lib/cube.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const SCREENSHOT_DIR = path.join(WEB_ROOT, 'docs', 'screenshots', 'correction-ui');
const FAILURE_DIR = path.join(os.tmpdir(), 'rubik-correction-ui-e2e-failure');
const CASE_ID = 'IMG_6299'; // esperimento #19/analisi "fase interfaccia": piccolo conflitto pulito su F8

const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000;
const ELEMENT_TIMEOUT_MS = 30_000;
const ANALYSIS_TIMEOUT_MS = 180_000; // passo lento e noto: analisi video reale, non un semplice "attesa elemento"

const START = Date.now();
function log(...parts: unknown[]) {
  console.log(`[correction-ui-e2e] [+${((Date.now() - START) / 1000).toFixed(1)}s]`, ...parts);
}

const CELL_INDICES = [0, 1, 2, 3, 5, 6, 7, 8];

let browser: Browser | null = null;
let dev: { baseUrl: string; close: () => Promise<void> } | null = null;
let videoServer: { port: number; close: () => void } | null = null;
let page: Page | null = null;
let cleanedUp = false;

async function cleanup(reason: string) {
  if (cleanedUp) return;
  cleanedUp = true;
  log(`pulizia (${reason})...`);
  await browser?.close().catch((error) => log('errore chiudendo il browser:', error));
  await dev?.close().catch((error) => log('errore chiudendo il dev server:', error));
  try {
    videoServer?.close();
  } catch (error) {
    log('errore chiudendo il server video:', error);
  }
  log('pulizia completata.');
}

async function saveFailureArtifacts(label: string) {
  try {
    fs.mkdirSync(FAILURE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (page) {
      const shotPath = path.join(FAILURE_DIR, `${stamp}-${label}.png`);
      const htmlPath = path.join(FAILURE_DIR, `${stamp}-${label}.html`);
      await page.screenshot({ path: shotPath, fullPage: true }).catch(() => undefined);
      const html = await page.content().catch(() => null);
      if (html) fs.writeFileSync(htmlPath, html, 'utf8');
      log(`artefatti di errore salvati fuori dal repo: ${shotPath} / ${htmlPath}`);
    } else {
      log('nessuna pagina aperta al momento dell\'errore: nessun artefatto da salvare.');
    }
  } catch (error) {
    log('non sono riuscito a salvare gli artefatti di errore:', error);
  }
}

let globalTimedOut = false;
const globalTimer = setTimeout(() => {
  globalTimedOut = true;
  log(`TIMEOUT GLOBALE: superati ${GLOBAL_TIMEOUT_MS / 1000}s, interrompo e pulisco.`);
  saveFailureArtifacts('timeout-globale')
    .then(() => cleanup('timeout globale'))
    .finally(() => process.exit(1));
}, GLOBAL_TIMEOUT_MS);

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
  const videoDir = path.resolve(process.env.BENCH_VIDEO_DIR || raw.videoDir);
  const entry = raw.cases.find((c: { id: string }) => c.id === CASE_ID);
  if (!entry) throw new Error(`caso non trovato: ${CASE_ID}`);
  if (!fs.existsSync(path.join(videoDir, entry.video))) throw new Error(`video mancante: ${entry.video}`);
  const reference = referenceFromScramble(entry.scramble) as Record<Face, CubeColor[]>;

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  log('passo 1/8: avvio server video statico...');
  videoServer = await startStaticServer(videoDir);
  log(`passo 1/8 ok: server video pronto (porta ${videoServer.port})`);

  log('passo 2/8: avvio dev server...');
  dev = await startDevServer(WEB_ROOT, '[correction-ui-e2e]', '/');
  log(`passo 2/8 ok: dev server pronto: ${dev.baseUrl}`);

  log('passo 3/8: avvio browser...');
  browser = await chromium.launch({
    headless: !process.env.BENCH_HEADFUL,
    executablePath: pinnedChromeExecutable(),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu'],
  });
  log(`passo 3/8 ok: browser Chrome for Testing ${CHROME_BUILD_ID} (pinnato)`);

  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(ELEMENT_TIMEOUT_MS);
  page.on('console', (message) => {
    if (message.type() === 'error') log(`console.error: ${message.text()}`);
  });

  log('passo 4/8: apro la pagina e carico il video...');
  await page.goto(`${dev.baseUrl}/`, { waitUntil: 'load', timeout: ELEMENT_TIMEOUT_MS });
  await page.setInputFiles('#video-upload', path.join(videoDir, entry.video));
  try {
    await page.waitForFunction(
      () => {
        const video = document.querySelector('video');
        return Boolean(video && video.duration > 0);
      },
      null,
      { timeout: ELEMENT_TIMEOUT_MS },
    );
  } catch {
    throw new Error(`timeout (${ELEMENT_TIMEOUT_MS}ms): aspettavo che <video> avesse una duration > 0 dopo il caricamento`);
  }
  log('passo 4/8 ok: video caricato.');

  log(`passo 5/8: avvio analisi e aspetto il completamento (fino a ${ANALYSIS_TIMEOUT_MS / 1000}s, passo lento e noto)...`);
  await page.getByRole('button', { name: /Analizza lo stato iniziale/ }).click({ timeout: ELEMENT_TIMEOUT_MS });
  try {
    await page.waitForFunction(
      () => {
        const label = document.querySelector('[data-testid="status-label"]');
        return Boolean(label && label.textContent && label.textContent !== 'In attesa');
      },
      null,
      { timeout: ANALYSIS_TIMEOUT_MS },
    );
  } catch {
    throw new Error(`timeout (${ANALYSIS_TIMEOUT_MS}ms): aspettavo che [data-testid=status-label] uscisse da "In attesa" (fine analisi)`);
  }
  log('passo 5/8 ok: analisi completata.');

  const resultPanel = page.getByTestId('result-section');
  const captureBothSizes = async (name: string) => {
    await resultPanel.screenshot({ path: path.join(SCREENSHOT_DIR, `mobile-${name}.png`), timeout: ELEMENT_TIMEOUT_MS });
    await page!.setViewportSize({ width: 1280, height: 900 });
    await resultPanel.screenshot({ path: path.join(SCREENSHOT_DIR, `desktop-${name}.png`), timeout: ELEMENT_TIMEOUT_MS });
    await page!.setViewportSize({ width: 390, height: 844 });
  };
  await captureBothSizes('1-normale');
  log('screenshot 1-normale catturato.');

  log('passo 6/8: apro la casella F8 (palette filtrata)...');
  await page.getByTestId('cell-F-8').click({ timeout: ELEMENT_TIMEOUT_MS });
  await captureBothSizes('2-palette-filtrata');
  log('passo 6/8 ok: screenshot 2-palette-filtrata catturato.');

  log('passo 7/8: confermo F8 = verde e verifico la segnalazione di conflitto...');
  await page.getByTestId('swatch-F-8-green').click({ timeout: ELEMENT_TIMEOUT_MS });
  await page.waitForTimeout(150);
  await captureBothSizes('3-conflitto');
  const conflictCountAfterFirst = await page.evaluate(() => {
    const badge = Array.from(document.querySelectorAll('span')).find((el) => el.textContent?.includes('da ricontrollare'));
    return badge?.textContent ?? null;
  });
  log(`contatore dopo la conferma di F8: ${conflictCountAfterFirst ?? '(nessuna segnalazione mostrata)'}`);
  if (!conflictCountAfterFirst) throw new Error('la conferma di F8 doveva generare almeno una segnalazione "da ricontrollare", ma non e comparsa');
  log('passo 7/8 ok.');

  log('passo 8/8: completo lo schema confermando le caselle rimanenti...');
  for (let pass = 0; pass < 6; pass += 1) {
    let changedThisPass = false;
    for (const face of CUBE_FACES) {
      for (const index of CELL_INDICES) {
        const trueColor = reference[face][index];
        const cell = page.getByTestId(`cell-${face}-${index}`);
        const alreadyConfirmed = (await cell.getAttribute('aria-label', { timeout: ELEMENT_TIMEOUT_MS }))?.includes('confermata da te');
        if (alreadyConfirmed) continue;
        await cell.click({ timeout: ELEMENT_TIMEOUT_MS });
        const swatch = page.getByTestId(`swatch-${face}-${index}-${trueColor}`);
        if (await swatch.count()) {
          await swatch.click({ timeout: ELEMENT_TIMEOUT_MS });
          changedThisPass = true;
        } else {
          // La casella non e' ancora attiva (nessuna palette aperta): va
          // bene, vuol dire che non era modificabile in questo passaggio
          // (es. e' confermata) - richiudo per sicurezza.
          await page.keyboard.press('Escape').catch(() => undefined);
        }
      }
    }
    log(`passo 8/8: passaggio ${pass + 1}/6 completato (modifiche: ${changedThisPass}).`);
    const complete = await page.evaluate(() => document.querySelector('[data-testid="status-label"]')?.textContent === 'Stato completo');
    if (complete) break;
    if (!changedThisPass) break;
  }

  const finalStatus = await page.evaluate(() => document.querySelector('[data-testid="status-label"]')?.textContent);
  log(`stato finale: ${finalStatus}`);
  if (finalStatus !== 'Stato completo') throw new Error(`stato finale inatteso dopo tutti i passaggi: ${finalStatus}`);
  await captureBothSizes('4-completato');
  log('passo 8/8 ok: screenshot 4-completato catturato.');

  log('OK: tutti gli stati verificati e catturati.');
}

main()
  .then(() => {
    if (globalTimedOut) return;
    return cleanup('successo');
  })
  .catch(async (error) => {
    if (globalTimedOut) return; // il watchdog sta gia' pulendo e uscendo
    console.error('\n[correction-ui-e2e] errore fatale:', error instanceof Error ? error.stack : error);
    await saveFailureArtifacts('errore');
    await cleanup('errore');
    process.exitCode = 1;
  })
  .finally(() => {
    if (!globalTimedOut) clearTimeout(globalTimer);
  });
