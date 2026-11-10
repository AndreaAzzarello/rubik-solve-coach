# Tracciamento 3D del cubo: fattibilità e piano (bozza, FASE 1)

Stato: **solo piano**, nessuna modifica al codice. Le soglie sono criteri
dichiarati prima di misurare; le stime di costo sono ipotesi, non misure.
Ultimo aggiornamento: 2026-11-10.

## Obiettivo di lungo periodo
Gemello digitale 3D del cubo seguito in tempo reale, anche con occlusioni da
mani, e trascrizione delle mosse (comprese M/E/S e mosse wide), con
keypoint densi (incroci della griglia, centri degli sticker), cubo 3D
proiettato, mosse trascritte e grafico TPS. Tutto nel browser, senza backend e
senza richieste a terzi (CSP `connect-src 'self' blob: data:`, `lib/csp.ts`).

## Punto di partenza (nel repo)
- YOLOv8n-pose a 512 px: 4 vertici per faccia, ordinati in senso orario, **senza
  identità della faccia** (`vision/dataset/annotation.ts`). La confidenza dei
  singoli keypoint oggi viene scartata (`lib/face-keypoint-model.ts`).
- Omografia 2D (`lib/homography.ts`); coordinate 3D degli sticker
  (`faceletPosition` in `lib/cube.ts`); camera pinhole e `projectPoint` nel
  generatore sintetico (`vision/dataset/camera.ts`), che disegna in canvas 2D con
  mani occludenti (`occluder.ts`): fornisce una **posa vera** per validare un PnP.
- Non esistono PnP, intrinseci, posa. `buildVirtualReplay` e `buildSolveTranscript`
  non sono usati dalla UI (solo test). Nessun controllo oggi sulle mosse M/E/S.
- Durante l'ispezione il cubo viene solo ruotato, non girato: i facelet restano
  quelli dello stato iniziale (verità del bench), utile per validare i colori.

## Approccio A: geometrico leggero (consigliato come primo passo)
- **Cosa**: PnP in TypeScript sui 4 vertici per faccia già prodotti da YOLO:
  IPPE per una faccia (due pose ambigue), DLT/EPnP + Gauss-Newton per 2-3 facce.
  Focale stimata una volta per video (ricerca su griglia che minimizza la
  riproiezione). Filtro temporale (continuità della posa, scelta fra le due
  ambiguità di IPPE). Identità delle facce dal colore del centro e
  dall'adiacenza dei quad.
- **Dati**: nessuno nuovo per costruirlo; il generatore sintetico dà la posa vera.
  Per validare su video reali: riproiezione leave-one-face-out, senza annotazioni.
- **Costo**: pochi giorni; zero MB; circa 1 ms per fotogramma (ipotesi, ≤ 12
  punti e 10 iterazioni).
- **Rischi**: ambiguità planare con una faccia sola; ambiguità di orientamento
  (rotazione di 90° della faccia); vertici rumorosi con mani sopra; la focale
  non è nota (video da telefono, possibile crop o stabilizzazione).
- **Dipendenze e licenze**: nessuna. Nessun cambio di licenza. OpenCV.js
  (Apache-2.0, circa 8-10 MB di WASM) solo come riferimento nel test, non come
  dipendenza.
- **Browser e CSP**: calcolo puro, nessuna rete, nessun file: compatibile.

## Approccio B: keypoint densi
- **Cosa**: estendere il generatore sintetico (`vision/dataset`) per etichettare
  gli incroci della griglia (16 per faccia, a rombo) e i centri degli sticker
  (9 per faccia, con colore), ciascuno con visibilità (visibile, occluso da
  mano, occluso dal cubo), con occlusioni sintetiche da mani. Nuovo modello pose.
  Confronto con A sugli stessi fotogrammi.
- **Dati**: nuovo dataset sintetico (il generatore è canvas 2D: va esteso, non
  riscritto); alcune centinaia di fotogrammi reali verificati a mano (gli incroci
  derivano dai 4 vertici con l'omografia: si controlla visivamente, non si
  annota da zero). Il dataset attuale pesa 181 MB (zip, non tracciato).
- **Costo**: settimane (generatore, training, validazione); training su
  Colab/GPU gratuita (da verificare le quote prima di partire).
- **Rischi**: divario sintetico/reale (anche mani e luce); un solo modello per
  quad, centri e visibilità può peggiorare i vertici; peso del modello e
  latenza in WASM senza GPU.
- **Dipendenze e licenze**: **Ultralytics YOLOv8 è AGPL-3.0 e, per Ultralytics,
  la licenza copre anche i pesi addestrati**. Il repo è già AGPL-3.0 (LICENSE,
  footer con link al sorgente), quindi coerente, ma qualunque riuso fuori da
  AGPL richiederebbe una licenza commerciale (a pagamento: **fuori vincolo**).
  Alternativa da valutare: RTMPose/RTMO (codice Apache-2.0; licenza dei pesi
  **da verificare**, probabilmente da riaddestrare su dati propri).
- **Browser e CSP**: `onnxruntime-web` same-origin, come oggi; nessuna rete. Il
  modello va servito da `public/` (limite Workers: 25 MiB per file).
- **Quando**: solo se A mostra che il limite sono i keypoint, non il PnP.

## Approccio C: ibrido articolato (solo direzione futura)
- **Cosa**: posa del cubo + stato dei facelet + rotazione degli strati, con
  memoria dello stato quando le mani coprono le facce; trascrizione delle mosse
  comprese M/E/S e wide; grafico TPS.
- **Dati**: sequenze di mosse annotate con tempi (vedi sotto); in sintetico,
  animazioni di strati.
- **Costo**: mesi; si costruisce sopra A (e forse B). Prematuro pianificarlo oltre.
- **Rischi**: M/E/S e wide sono ambigue (M = R L' x'): la trascrizione va definita
  su un riferimento fisso (centri); occlusioni lunghe; deriva dello stato.
- **Dipendenze**: Three.js (MIT) solo se cubing.js non basta per il gemello
  articolato. Licenze come A, più quelle di B se si usa.
- **Browser e CSP**: compatibili se tutto resta locale.

## Verità di terreno: il minimo che serve da te
1. **Inizio e fine dell'ispezione per i 13 video** (26 tempi in secondi, ±0,2 s).
   Strumento: un player con avanzamento a fotogramma e timestamp (VLC o
   equivalente) e un file CSV locale, **fuori dal repo**. Chiude anche il #21
   (stabilità ≠ correttezza). Serve a: A (finestra in cui validare) e al
   registro.
2. **Per A, nient'altro**: la posa vera arriva dal sintetico, la riproiezione
   leave-one-face-out non richiede annotazioni, i colori si confrontano con la
   verità del bench (facelet iniziali).
3. **Per B (dopo A)**: verifica visiva di circa 50-100 fotogrammi reali con gli
   incroci proiettati dai 4 vertici (corretto / da spostare). Strumento: una
   pagina locale di debug, senza salvataggio nel repo.
4. **Per C (molto dopo)**: un solo video con circa 20 mosse annotate con tempo
   (almeno una M/E/S e una wide). Strumento: pagina locale di debug con
   avanzamento a fotogramma e tasti per le mosse.

## Punto 8: prototipo `proto/3d-pose-overlay` (approccio A)
- **Criteri dichiarati prima, da non cambiare dopo aver visto i numeri.**
  - Successo, tutti insieme: errore di riproiezione **p90 ≤ 8 %** della
    diagonale della faccia; posa valida in **≥ 70 %** dei fotogrammi con faccia
    rilevata; accordo dei colori **≥** a quello dell'omografia su ogni video;
    **≤ 5 ms** per fotogramma.
  - Arresto, uno qualsiasi: p90 > 15 %; posa valida < 40 %; 4 giorni di lavoro.
  - Tra i due: si decide insieme se continuare.
- **Definizione di «posa valida»** (confermata): PnP convergente, cubo davanti
  alla camera (profondità > 0), focale entro [0,5 ; 3,0] volte la larghezza del
  fotogramma (intervallo dichiarato qui, prima di misurare) e riproiezione RMS
  ≤ **15 %** della diagonale sui punti usati, cioè la soglia di arresto. Non l'8 %:
  l'8 % è il criterio di successo sul p90 e usarlo anche per validare la posa
  renderebbe la metrica circolare.
- **Sviluppo e taratura solo sui 10 video fuori dal gruppo test.** I video del
  gruppo test (6258, 6260, 6281) si usano **una sola volta**, per la valutazione
  finale, a parametri congelati (commit e valori fissati prima del run).
- **Metodo**: script offline (dev server + Chromium come il bench: bench-safety,
  un run alla volta, ogni script su video reali autorizzato dall'utente), solo
  nella finestra di ispezione. Metriche: riproiezione leave-one-face-out (posa da 2
  facce, previsione dei vertici della terza), media e p90; percentuale di posa
  valida; jitter fra fotogrammi consecutivi; colori campionati ai centri
  proiettati contro i facelet del bench, confrontati con il campionamento a
  omografia sugli stessi fotogrammi; ms per fotogramma.
- **Passi**: (1) esporre la confidenza dei keypoint senza cambiare il
  comportamento; (2) `lib/pose/pnp.ts` con test sintetici sulla posa vera del
  generatore; (3) raggruppare i quad adiacenti per fotogramma e assegnarli alle
  facce; (4) posa e focale per video; (5) proiettare le 54 caselle con
  visibilità dalla normale; (6) overlay e metriche.
- **Overlay solo in `/bench` o in una pagina di debug**, mai nella UI pubblica
  (nessun link, `noindex`). Metriche JSON in `bench/results/` (gitignored).
- **Dati personali**: i video del bench non compaiono in test, fixture o
  screenshot; gli screenshot stanno fuori dal repo (scratchpad). I test usano
  solo dati sintetici.
- **Promozione in produzione**: no. Al massimo una voce #22 nel registro.
- Nessuna modifica alla pipeline di produzione.

## Punto 7: visualizzatore cubing.js (`feat/twisty-viewer`)
- **Cosa**: `TwistyPlayer` (`cubing/twisty`) che mostra lo stato ricostruito e lo
  scramble. Lo stato iniziale si imposta con `experimentalSetupAlg` = scramble
  ricostruito (da `lib/inspection-solver.ts`, che usa cubejs; cubing.js resta un
  visualizzatore e non sostituisce `lib/cube.ts`); `experimentalSetupAnchor`,
  `visualization` 3D o 2D; la soluzione trascritta come `alg`.
- **Import lazy**: componente client con `import('cubing/twisty')` dentro
  `useEffect` (SSR/RSC non hanno il DOM necessario). Fuori dal bundle iniziale.
- **Dove**: prima solo in una pagina di debug (`/bench/viewer`); la
  promozione alla pagina pubblica è una decisione del redesign.
- **Licenza**: `cubing` 0.66.1, **MPL-2.0 OR GPL-3.0-or-later** (verificato da
  npm); si usa senza modificarlo sotto MPL-2.0, compatibile con AGPL-3.0.
  Dipende da `three` (MIT). Da aggiungere a `docs/legal/ATTRIBUZIONI.md`.
- **CSP e rete (da verificare in Fase 2, non ancora verificato)**: con
  `connect-src 'self' blob: data:` e **zero richieste esterne** (log delle
  richieste in Playwright con il pannello aperto); controllare che il chunk
  lazy e gli eventuali worker restino same-origin; controllare peso del chunk,
  limite Workers 25 MiB per file e funzionamento nel build vinext/Cloudflare.
- **Verifica**: stato mostrato = stato ricostruito (confronto con cubejs);
  tastiera e `aria-label`; nessun overflow a 390 e 1440 px; nessun errore in
  console oltre ai noti.
- **Three.js diretto**: no, finché non serve il gemello articolato (C).

## Ordine, worktree, parallelismo
| Passo | Branch (da `main`) | Worktree Orca | Note |
|---|---|---|---|
| 9. Questo documento | `main` | radice | solo documento |
| 7. Visualizzatore | `feat/twisty-viewer` | `.../orca/workspaces/rubik-solve-coach/twisty-viewer` | richiede `pnpm install` (nuove dipendenze `cubing`, `three`): chiedo prima |
| 8. Prototipo A | `proto/3d-pose-overlay` | `.../3d-pose-overlay` | nessuna nuova dipendenza; `pnpm install` solo se serve |
| B | solo dopo i risultati di A | da decidere | |
| C | solo direzione | | |

- In parallelo: 7 e 8 (non condividono codice né bench). `exp/robust-window`
  resta com'è (protetto dal tag `exp21-variante-d`).
- Un solo bench alla volta: gli script di A con video reali sono bench; il
  visualizzatore non usa video. I dev server del visualizzatore usano la porta
  3200 e non girano durante un bench.
- Nessun push, nessun bench senza richiesta esplicita, diff e ok prima di ogni
  commit.

## Note per dopo
- `cube-face-keypoints.onnx` è tracciato in due copie identiche (12,6 MB:
  `web/public/models/` e `web/vision/models/`). Da valutare in seguito se
  deduplicarlo (una sola copia, l'altra generata o referenziata); non si fa ora.

