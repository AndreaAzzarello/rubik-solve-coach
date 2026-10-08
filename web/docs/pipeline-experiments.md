# Esperimenti sulla pipeline di ricostruzione (ottobre 2026)

Bench di riferimento: 13 video (`bench/cases.json`) — 3 "test" mai visti dal
modello (IMG_6258/6260/6281, le sole decisive per cambi di MODELLO), 2
"integration" (IMG_6107/6108), 8 "seen" usati in training. Baseline storica
(esperimenti #1-9) = 359/702 (gruppo test 130/162: 6258=54, 6260=39,
6281=37). **Baseline attuale (dopo l'adozione dell'esperimento #10) =
402/702**, gruppo test invariato 130/162.

Ogni riga: cosa è stato provato → risultato sui 13 video → perché è stato
scartato (o adottato). Solo l'esperimento #10 è in produzione; tutti gli
altri no.

1. **finetune-crops.onnx da solo** (checkpoint fine-tuned, sostituiva il
   modello di produzione) → PCK migliore ma bench 6281 crolla a 16/54 →
   scartato: criterio "nessun video giù di più di 5" violato.
2. **Ibrido pass1=attuale/pass2=finetune-crops** (due modelli diversi per i
   due passaggi) → guadagni netti su 2/3 video test, ma 6281 crolla ancora
   di più, a 10/54 → scartato, stesso criterio.
3. **Fuse-prima** (antepone candidate fuse a sourceFrames≥2 ai raw, senza
   altro cambiamento) → 6281 -20; instabilità bidirezionale enorme sui
   "seen" (6300 +41, altri -20/-21) → scartato: il riordino da solo non crea
   vera fusione multi-fotogramma, sposta solo quale singola lettura vince.
4. **Finestra temporale estesa (fino a tutta l'ispezione) + fuse-prima
   insieme** → 6281 -25, ancora peggio del solo fuse-prima → scartato.
5. **Rimozione della riduzione a singola-migliore-per-faccia** (V1,
   `selectSingleBestModelObservationPerFace` bypassata) → totale pipeline
   sale a 400/702, ma 3 video crollano >20 caselle (6281 -21, 6297 -19,
   6338 -20) → scartato dal criterio di sicurezza, nonostante il guadagno
   aggregato.
6. **Fix del dedup in `fuseFaceObservationCandidates`** (tiene il candidato
   con più sourceFrames per pattern, non il primo trovato) combinato con V1
   → risolve solo parzialmente il caso diagnosticato (6338/faccia B vince
   localmente ma il beam-search fra facce lo compensa comunque con altre
   facce ancora sbagliate) → il totale non si muove abbastanza, non
   adottato con V1. Il fix isolato, testato DA SOLO in produzione normale
   (senza V1), **non è un no-op come previsto**: 6258 -19, 6281 +10 e altri
   spostamenti — significa che in produzione normale arriva più di una
   osservazione alla fusione in alcuni casi (es. l'osservazione sintetica
   "balanced"). Rimosso anche questo.
7. **Redesign a due fasi** (clustering tollerante alla rotazione + voto
   cella-per-cella pesato per evidenza, sostituendo la riduzione a
   singola-migliore; orientamento assoluto lasciato al risolutore dei
   vincoli fisici, 4 rotazioni, centri vicini solo come spareggio) →
   peggiora tutto: 352/702 (sotto sia baseline 359 sia V1 400), 6281 crolla
   a -30, e 6338 — il caso bersaglio dell'intero redesign — peggiora
   ulteriormente a 10/54 invece di migliorare → scartato.
8. **Discriminante dedicato rosso/arancione** (`resolveRedOrangeAxis`:
   quando una cella è classificata rosso o arancione, la decisione viene
   rifatta proiettando il campione sulla retta Lab fra i centri rosso e
   arancione calibrati su QUESTO video, invece del confronto CIEDE2000 a
   tutti e 6 i colori — nessun'altra fusione o colore toccato) → risolve
   ESATTAMENTE il problema diagnosticato (faccia D passa da 2-3/9 a 9/9 su
   6281 e 7/7 su 6297, zero errori rosso/arancione residui su entrambe) —
   ma la sua confidenza (scala diversa da CIEDE2000) destabilizza quante
   celle vengono accettate in altri video: 386/702 totale pipeline (sopra
   baseline 359) ma gruppo test scende a 123/162 (sotto 130) e 6260 crolla
   di 7 caselle (39→32, oltre il limite di 5) → criterio fallito, scartato
   nonostante avesse risolto la causa originale.

   **Pista aperta**: è l'UNICO esperimento di questo log che ha risolto
   esattamente il caso bersaglio (6281/D 9/9, 6297/D 7/7). Il fallimento non
   viene dalla logica rosso/arancione in sé, ma dall'aver sostituito anche
   la CONFIDENZA con una scala diversa (proiezione Lab) da quella CIEDE2000
   di `classifyCalibratedColor` — questo ha alterato quante celle vengono
   accettate anche in facce non coinvolte (6260 −7). Prossimo tentativo
   suggerito: sovrascrivere SOLO l'etichetta rosso/arancione quando
   `resolveRedOrangeAxis` è applicabile, mantenendo la confidenza originale
   di `classifyCalibratedColor` invariata.
9. **Isolare la sola etichetta rosso/arancione** (`classifyCalibratedCell`:
   stessa proiezione di #8, ma sovrascrive SOLO il colore — la confidenza
   resta sempre quella CIEDE2000 originale, bit-identica, verificato con 2
   test unitari dedicati) → l'ipotesi della pista aperta di #8 era
   **sbagliata**: isolare la confidenza non risolve il problema, lo
   peggiora. 6297/D resta perfetto (7/7, invariato da #8), ma **6281 crolla
   da 37 a 8/54** (-29, peggio della regressione di #8 su 6260) — non per
   un singolo colore sbagliato, ma per un collasso di copertura su TUTTE le
   facce (quasi tutte 1-2 celle impegnate su 9): il cambio di etichetta,
   mantenendo invariata (spesso alta) la confidenza originale, fa sì che il
   risolutore dei vincoli fisici tratti la cella ri-etichettata come prova
   forte per un piazzamento che confligge con i pezzi adiacenti, facendo
   collassare il beam-search su quel video. Totale pipeline 361/702 (sopra
   359 per 2 punti) ma criterio di sicurezza fallito platealmente →
   scartato, nessuna pista aperta residua: il mascheramento della
   confidenza in #8 non era il bug, era (inconsapevolmente) un argine a un
   problema più profondo nel risolutore dei vincoli.

10. **Filtro delle osservazioni per indice di allineamento griglia**
    (`lib/grid-alignment-index.ts` + `applyGridAlignmentFilter` in
    `lib/video-decoder.ts`: scartare a monte, prima della fusione, le
    osservazioni-modello la cui griglia è storta rispetto ai confini di
    colore reali — indice puramente geometrico, energia del gradiente di
    colore sulle linee interne della griglia vs dentro le celle, mai colori
    classificati — diagnosticato con AUC 0,971 su 52 osservazioni
    giuste/52 sbagliate, vedi `vision/eval/grid-alignment-signal.ts` e
    `docs/experiment-10-step1-threshold-sweep.md`) → **ADOTTATO**, con
    soglia 4, salvaguardia per non perdere mai una faccia (se tutte le
    osservazioni di un colore sono sotto soglia, tiene quella con l'indice
    più alto).

    Bench sui 13 video, 3 soglie:

    | Video | Baseline | Soglia 3 | Soglia 4 | Soglia 6 |
    |---|---|---|---|---|
    | 6107 | 54 | 54 | 54 | 54 |
    | 6108 | 8 | 11 | 11 | 11 |
    | 6258 (test) | 54 | 54 | 54 | 54 |
    | 6260 (test) | 39 | 39 | 39 | 50 |
    | 6281 (test) | 37 | 37 | 37 | 37 |
    | 6297 | 28 | 28 | 28 | 28 |
    | 6298 | 30 | 30 | 30 | 30 |
    | 6299 | 12 | 12 | 12 | 20 |
    | 6300 | 9 | 19 | 19 | 32 |
    | 6334 | 24 | 51 | 54 | 54 |
    | 6336 | 16 | 12 | 12 | 25 |
    | 6338 | 37 | 41 | 41 | 41 |
    | 6341 | 11 | 11 | 11 | 11 |
    | **TOTALE** | **359** | **399** | **402** | **447** |

    Criterio di adozione, tutti e 3 soddisfatti: (1) soglia principale 4
    sopra baseline (402>359); (2) nessun video test (6258/6260/6281) scende
    di più di 5 caselle a nessuna delle 3 soglie (6260 anzi sale a 50 con
    soglia 6); (3) le soglie vicine 3 e 6 restano entrambe sopra baseline
    (399 e 447).

    Video che cambiano di più di 10 caselle a soglia 4, spiegati con i dati
    misurati (conteggio osservazioni-modello prima/dopo il filtro e
    salvaguardia scattata, per video, somma su 3 ripetizioni):
    - **6334 (+30, 24→54)**: 504 osservazioni prima del filtro, 162 dopo;
      **salvaguardia scattata 18 volte su 18 possibili** (6 colori × 3
      ripetizioni) — ogni singolo gruppo-colore aveva TUTTE le sue
      osservazioni sotto soglia, quindi il filtro ha selezionato (via
      salvaguardia) una sola osservazione per faccia, quella con l'indice
      di allineamento più alto, bypassando il voto multi-frame. Per questo
      video la singola lettura più ben allineata geometricamente è più
      affidabile della fusione fra più letture (probabilmente la maggior
      parte delle letture proviene da inquadrature storte che fondendosi
      convergono su un consenso sbagliato).
    - **6300 (+10, 9→19)**: 492 prima, 228 dopo; salvaguardia scattata 9
      volte su 18 possibili (metà dei gruppi-colore) — effetto parziale
      dello stesso meccanismo, coerente con un miglioramento minore.

## Diagnosi trasversale (non un esperimento, un fatto osservato)

- Due cause distinte dietro le regressioni di V1: **errore cromatico
  sistematico rosso/arancione** (6281, 6297 — la maggioranza delle
  osservazioni vota compattamente il colore sbagliato con la STESSA
  confidenza della minoranza corretta, quindi nessun criterio di "consenso
  netto" lo risolve) e **frammentazione per rotazione** (6338 — la stessa
  lettura arriva in orientamenti diversi con celle occluse in posizioni
  diverse, spezzando un consenso altrimenti unanime).

## Conclusione

La ricostruzione è sensibile in modo **caotico**, non incrementale: ogni
variante tentata sposta singoli video di **±20-40 caselle su 54**, senza un
pattern prevedibile dalla teoria che la motivava. Un cambiamento pensato per
risolvere un caso specifico (es. 6338) può lasciarlo invariato o peggiorarlo,
mentre ne sposta altri in modi non previsti. Non fidarsi di un miglioramento
aggregato sul totale pipeline senza controllare ogni singolo video del
gruppo "test": un totale più alto può nascondere un singolo video crollato
di decine di caselle. Prima di riprovare una direzione simile a una già
elencata sopra, verificare che non sia già stata scartata qui.

L'esperimento #10 è il primo a rompere questo schema: agisce PRIMA della
fusione (scartando osservazioni geometricamente storte), non dentro di essa,
usando un segnale (pixel grezzi) indipendente dalla lettura colore che ha
reso tutti i tentativi precedenti instabili — risultato coerente su 3
soglie diverse, nessuna regressione sul gruppo test.
