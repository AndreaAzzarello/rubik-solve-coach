# Banco di prova · ricostruzione dello stato del cubo

Misura, in modo ripetibile e **non ottimistico**, quanto bene la pipeline
ricostruisce lo scramble da un video di ispezione. Serve a dare un numero
stabile contro cui confrontare ogni futura modifica alla pipeline.

## Numero di riferimento

**Caselle giuste su 54**, con allineamento *identità*: entrambi i lati sono già
nella convenzione canonica (centri bianco/rosso/verde/giallo/arancio/blu su
U/R/F/D/L/B), quindi si confronta casella per casella senza cercare rotazioni e
senza rimappare i colori per faccia.

Il report riporta anche:

- **giuste / 48** escludendo i centri (i centri sono corretti per costruzione e
  gonfiano il punteggio del +6);
- **impegnate / 48** — caselle su cui la pipeline si è espressa (le altre
  restano `null` e non contano né giuste né sbagliate);
- **precisione su impegnate** — giuste / impegnate;
- **istogramma colori** ricostruito vs atteso (9 per colore): rende evidente
  uno sbilanciamento tipo "arancio 10, bianco 7";
- **diagnosi orientamento** — miglior risultato sulle 24 rotazioni di cubo
  intero. **Non è il punteggio.** Se batte l'identità di un margine netto c'è un
  offset di orientamento *sistematico* (bug da correggere nel codice); se è
  vicino all'identità gli errori sono sparsi (colore/griglia).

## Come funziona

La ricostruzione richiede il canvas del browser (decodifica del video, seek,
`getImageData`), quindi gira in **Chromium headless** pilotato da Playwright:

1. `bench/run-bench.ts` avvia il dev server dell'app (`vinext dev`) e un piccolo
   server statico locale per i video (con supporto `Range` e header CORS,
   entrambi indispensabili per il seek di `<video>` e per non "sporcare" il
   canvas cross-origin);
2. apre `/bench` (`app/bench/page.tsx`), che espone
   `window.__benchReconstruct(url)` ed esegue **la stessa** funzione della
   pagina principale — `reconstructInspectionFromVideo` in
   `lib/inspection-pipeline.ts` — restituendo lo schema ricostruito;
3. `bench/lib/score.ts` (puro, testato in `bench/score.test.ts`) calcola lo
   stato reale dallo scramble con `CubeState` e produce il punteggio.

Poiché la pagina principale e il banco condividono
`lib/inspection-pipeline.ts`, il punteggio misura sempre il percorso reale.

## Uso

```bash
# tutti i casi definiti in bench/cases.json
pnpm bench

# un solo caso
pnpm bench IMG_6107

# override della cartella dei video / numero di ripetizioni / browser visibile
BENCH_VIDEO_DIR="D:/video" BENCH_REPEATS=1 BENCH_HEADFUL=1 pnpm bench
```

Ogni caso viene eseguito `repeats` volte (default 3) per misurare il rumore; il
report mostra tutte le ripetizioni e la mediana. Risultati salvati in
`bench/results/<timestamp>.json` e `bench/results/latest.json` (cartella
ignorata da git).

Solo il test dello scorer (veloce, senza browser) fa parte della CI, tramite
`pnpm run test:inspection`.

## Requisiti

- **Google Chrome** installato: il Chromium di Playwright non ha i codec
  proprietari e non decodifica gli `.mp4` H.264. Il driver usa il Chrome di
  sistema (`channel: "chrome"`) e ripiega sul Chromium del bundle solo se manca.
  Prima volta: `pnpm exec playwright install chromium`.
- I **video** restano locali (fuori dal repo). `bench/cases.json` ne elenca
  nomi, scramble e cartella; `BENCH_VIDEO_DIR` la sovrascrive.
- Rete: il modello mani MediaPipe viene scaricato da CDN; se non è
  raggiungibile la pipeline degrada come in produzione (solo cubo).

## cases.json

```jsonc
{
  "videoDir": "C:/Users/Andrea/Desktop/App/lenti",
  "repeats": 3,
  "cases": [
    { "id": "IMG_6107", "video": "IMG_6107.mp4",
      "scramble": "F L2 B2 D ...", "orientation": "white-U/green-F" }
  ]
}
```

Lo `scramble` è la sequenza applicata a un cubo risolto con **bianco sopra e
verde davanti** (convenzione WCA, la stessa dell'app).

## Interpretare un calo

- Punteggio identità basso **e** best-24-rotazioni vicino → problema di
  lettura colore o di geometria della griglia 3×3.
- best-24-rotazioni molto più alto dell'identità → offset di orientamento
  sistematico introdotto nel codice.
- identità e best-24 entrambi bassi ma **istogramma colori quasi perfetto** →
  sospetta un disallineamento di indici per faccia (trasposizione/specchio) tra
  `lib/inspection-state.ts` e `lib/cube.ts`: è un bug, non un'opzione di
  punteggio.
- Molte caselle `null` (`unknown` nell'istogramma) → la pipeline non trova la
  griglia in abbastanza fotogrammi.
