# bench/vendor — dipendenze MediaPipe congelate

Il banco di prova NON deve dipendere da CDN esterni: il runtime WASM e il modello
mani di MediaPipe cambiano nel tempo (rebuild del runtime, ripubblicazione del
modello sullo stesso path `/1/`) e sposterebbero il punteggio senza che il codice
sia cambiato. Qui sono congelati e versionati nel repo.

`bench/run-bench.ts` intercetta (via `page.route`) le due URL remote usate da
`lib/hand-motion.ts` e le serve da questi file:

| File remoto | Servito da |
|---|---|
| `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/*` | `mediapipe/wasm/*` |
| `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` | `mediapipe/hand_landmarker.task` |

Il codice dell'app non è toccato: in produzione le URL restano quelle del CDN.

## Contenuto

- `mediapipe/wasm/` — copia di `node_modules/@mediapipe/tasks-vision@1.0.1/wasm/`
  (stessa versione pinnata in `package.json` / lockfile).
- `mediapipe/hand_landmarker.task` — `hand_landmarker` float16 rev. 1, SHA-256
  `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.

## Rifare il vendoring (scelta esplicita → ri-baselinea il bench)

```sh
cp node_modules/@mediapipe/tasks-vision/wasm/* bench/vendor/mediapipe/wasm/
curl -L -o bench/vendor/mediapipe/hand_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
```
