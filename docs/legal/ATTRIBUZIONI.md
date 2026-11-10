# Licenza e attribuzioni di terze parti — CubeSolve Coach

> **BOZZA.** Elenco ricavato da `web/package.json` e dai `package.json`
> installati (versioni al 2026-11-10). I testi completi delle licenze stanno nei
> rispettivi pacchetti (`node_modules/<pacchetto>/LICENSE`). Da rivedere a ogni
> aggiornamento delle dipendenze.

## Licenza del progetto
Questo progetto è distribuito con licenza **GNU Affero General Public License
v3.0** (`LICENSE`). Copyright [[DA COMPLETARE: titolare e anno]].

Codice sorgente: <https://github.com/AndreaAzzarello/rubik-solve-coach>. Chi usa
l'app attraverso la rete deve poter raggiungere il sorgente corrispondente
(AGPL-3.0, §13): il collegamento va esposto nell'interfaccia
[[DA COMPLETARE nel redesign: posizione del link «Codice sorgente»]].

## Modello di rilevamento delle facce
| Componente | Licenza | Note |
|---|---|---|
| `cube-face-keypoints.onnx` (modello fine-tuned) | AGPL-3.0 | Derivato da Ultralytics YOLOv8n-pose (AGPL-3.0). Trattato come soggetto alla stessa licenza del progetto. |
| Pesi di partenza Ultralytics (`yolov8n-pose.pt`, usati se non si riparte da un checkpoint precedente) | AGPL-3.0 | Preaddestrati da Ultralytics. [[DA VERIFICARE: attribuzione dei dati di preaddestramento, es. COCO]] |

Il codice di addestramento Ultralytics non fa parte del prodotto distribuito;
il modello esportato sì. Per usi non compatibili con l'AGPL-3.0 esiste una
licenza commerciale Ultralytics, da valutare prima di qualunque altro uso.

## Risorse usate dall'app a runtime
| Componente | Versione | Licenza |
|---|---|---|
| `@mediapipe/tasks-vision` (runtime WASM e JS) | 1.0.1 | Apache-2.0 |
| MediaPipe Hand Landmarker (`hand_landmarker.task`, float16 rev. 1) | — | Apache-2.0 [[DA VERIFICARE sulla scheda del modello MediaPipe]] |
| `onnxruntime-web` (incluso il runtime WASM) | 1.30.0 | MIT |
| `cubejs` (solutore) | 1.3.2 | MIT |
| `color-diff` | 1.4.0 | BSD-3-Clause |
| `next` | 16.2.6 | MIT |
| `react`, `react-dom` | 19.2.6 | MIT |

Tutte compatibili con la distribuzione sotto AGPL-3.0.

## Strumenti di sviluppo (non distribuiti con l'app)
`@cloudflare/vite-plugin`, `@cloudflare/workers-types`, `wrangler`,
`@openai/sites-vite-plugin`, `vinext`, `vite`, `@vitejs/plugin-react`,
`@vitejs/plugin-rsc`, `react-server-dom-webpack`, `tailwindcss`,
`@tailwindcss/postcss`, `typescript`, `eslint`, `eslint-config-next`,
`@types/*`, `onnxruntime-node`, `playwright`, `@puppeteer/browsers`.
Licenze: MIT, Apache-2.0, oppure doppia MIT OR Apache-2.0
(`@cloudflare/workers-types`, `wrangler`).

## Dati e video
I video di test e i fotogrammi estratti non fanno parte del repository né del
prodotto. Il dataset di addestramento sintetico è generato dal codice in
`web/vision/dataset/`. [[DA COMPLETARE: dichiarazione sui fotogrammi reali
usati nell'addestramento e sulla loro provenienza]]
