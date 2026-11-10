# MediaPipe servito dall'app (`public/mediapipe/`)

Il runtime WASM e il modello mani di MediaPipe sono file dell'app, non risorse
di un CDN: a runtime l'app non contatta domini di terzi, e il banco di prova non
dipende da file che cambiano nel tempo (rebuild del runtime, ripubblicazione del
modello sullo stesso path `/1/`).

`lib/hand-motion.ts` costruisce i percorsi con `assetUrl()` (`lib/asset-url.ts`),
che rispetta il `basePath` di next.config (iniettato da vinext come
`process.env.__NEXT_ROUTER_BASEPATH`; vuoto con il deploy alla radice).

## Contenuto

| File | Origine |
|---|---|
| `public/mediapipe/wasm/vision_wasm_internal.{js,wasm}` | copia di `node_modules/@mediapipe/tasks-vision/wasm/` (versione 1.0.1, la stessa pinnata in `package.json` e lockfile) |
| `public/mediapipe/wasm/vision_wasm_nosimd_internal.{js,wasm}` | idem (variante senza SIMD) |
| `public/mediapipe/hand_landmarker.task` | `hand_landmarker` float16 rev. 1, SHA-256 `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` |

Sono solo i file che `FilesetResolver.forVisionTasks(root)` di tasks-vision 1.0.1
carica davvero: sceglie `vision_wasm[_module][_nosimd]_internal` e, senza
`useModule`, non usa mai le varianti `_module_`, che quindi non sono incluse.
Il file piu' grande e' 11,2 MiB, sotto il limite di 25 MiB per file dei Workers
(static assets).

Licenze: vedi `docs/legal/ATTRIBUZIONI.md`.

## Verifica

`bench/lib/mediapipe-local.ts` controlla che i cinque file esistano e che il
`.task` abbia l'hash fissato (test in `mediapipe-local.test.ts`). `run-bench.ts`
e i collettori `window-*.ts` si fermano se i file non sono integri; `run-bench.ts`
segnala inoltre, a fine run, se MediaPipe non e' stato caricato da `/mediapipe/`
o se il browser ha contattato i CDN.

## Rifare il vendoring (scelta esplicita: ri-baselinea il bench)

```sh
cp node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.* web/public/mediapipe/wasm/
cp node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.* web/public/mediapipe/wasm/
curl -L -o web/public/mediapipe/hand_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
```

Poi aggiornare `MEDIAPIPE_TASK_SHA256` in `bench/lib/mediapipe-local.ts`, questo
file e `docs/legal/ATTRIBUZIONI.md`.

**Invalidare la cache del browser.** Il service worker (`public/sw.js`) serve i
file di `/mediapipe/` in cache-first, senza rivalidarli: chi li ha gia' in cache
non li riscarica da solo. Quando si aggiorna MediaPipe va quindi cambiato il
nome della cache (`CACHE_NAME`, es. `cube-scanner-video-v6`) oppure il
percorso dei file (es. `public/mediapipe-1.1.0/`, aggiornando
`lib/hand-motion.ts`): all'attivazione il service worker elimina le cache
`cube-scanner-video-*` con un nome diverso.
