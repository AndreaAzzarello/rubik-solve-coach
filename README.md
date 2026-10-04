# CubeSolve Coach

Analizza la risoluzione di un cubo di Rubik 3x3 da un video: ricostruisce lo
stato iniziale, trascrive le mosse e le divide nelle fasi CFOP (Cross, F2L,
OLL, PLL).

Tutto il codice vivo sta in [`web/`](web/) (Next.js + TypeScript): non esiste
un backend separato, l'intera pipeline (decodifica video, rilevamento facce,
ricostruzione, risoluzione) gira nel browser.

## Pipeline di visione

Il rilevamento dei 4 vertici di ogni faccia visibile usa un modello
YOLOv8n-pose fine-tuned, esportato in ONNX ed eseguito nel browser con
`onnxruntime-web` (`web/lib/face-keypoint-model.ts`). Due passaggi per
fotogramma: un primo passaggio sull'immagine intera localizza il cubo, un
secondo passaggio su un ritaglio zoomato attorno al cubo raffina i vertici
quando il cubo e' piccolo nel fotogramma (puo' solo migliorare le facce del
primo passaggio, mai perderne). Dai 4 vertici, un'omografia proietta i 9 punti
della griglia 3x3 e ne legge il colore (`web/lib/homography.ts`,
`web/lib/cell-sampling.ts`).

Un secondo percorso, puramente geometrico (sticker adiacenti raggruppati per
colore, senza modello), resta nel repository come baseline di confronto per
il banco di prova ma non e' piu' il percorso di produzione
(`web/lib/geometric-sticker-detection.ts`).

Addestramento, dataset ed eval del modello sono in `web/vision/` (annotazione
manuale, generazione dataset sintetico, notebook Colab per il fine-tuning,
script di confronto PCK fra checkpoint).

## Banco di prova (bench)

`pnpm --dir web bench` esegue la pipeline reale su video di test locali
(mai nel repository: la repo e' pubblica) e confronta lo stato ricostruito
con lo scramble noto, riportando "caselle giuste su 54" in modo deterministico
(Chrome for Testing pinnato, WASM/modello locali, nessuna GPU). Vedi
[`web/bench/README.md`](web/bench/README.md).

## Sviluppo

```powershell
pnpm --dir web install
pnpm --dir web dev              # app di sviluppo
pnpm --dir web test:inspection  # test del motore di ricostruzione/risoluzione
pnpm --dir web bench            # banco di prova end-to-end (richiede video locali)
```

CI (`.github/workflows/ci.yml`): lint, type check, test, build di `web/`.

## Video di test

I filmati personali e gli output di ispezione restano locali e non vengono
caricati su GitHub. Nel repository restano solo strumenti di analisi e
metadati non sensibili (scramble, orientamento, timestamp).

## Codice legacy

[`legacy-python/`](legacy-python/) contiene un primo motore di riferimento in
Python (notazione, stato dei 54 sticker, fasi CFOP) scritto prima di
convergere su `web/` come unica implementazione. Non e' piu' mantenuto, non
fa parte della CI e non e' collegato in alcun modo alla pipeline attuale.
