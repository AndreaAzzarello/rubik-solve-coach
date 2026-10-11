# Esperimenti sulla pipeline di ricostruzione (ottobre 2026)

Bench di riferimento: 13 video (`bench/cases.json`) — 3 "test" mai visti dal
modello (IMG_6258/6260/6281, le sole decisive per cambi di MODELLO), 2
"integration" (IMG_6107/6108), 8 "seen" usati in training. Baseline storica
(esperimenti #1-9) = 359/702 (gruppo test 130/162: 6258=54, 6260=39,
6281=37). **Baseline attuale (dopo l'adozione dell'esperimento #10, soglia
6) = 447/702**, gruppo test 141/162 (6258=54, 6260=50, 6281=37).

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

    **Soglia salita a 6** (2026-10-10): prima di adottare la soglia 6 come
    definitiva, verificato che non fosse un picco isolato sui 13 video
    bench-ando anche le soglie 5 e 8:

    | Video | Soglia 4 | Soglia 5 | Soglia 6 | Soglia 8 |
    |---|---|---|---|---|
    | 6107 | 54 | 54 | 54 | 54 |
    | 6108 | 11 | 11 | 11 | 11 |
    | 6258 (test) | 54 | 54 | 54 | 54 |
    | 6260 (test) | 39 | 50 | 50 | 46 |
    | 6281 (test) | 37 | 37 | 37 | 37 |
    | 6297 | 28 | 28 | 28 | 37 |
    | 6298 | 30 | 30 | 30 | 30 |
    | 6299 | 12 | 13 | 20 | 19 |
    | 6300 | 19 | 19 | 32 | 32 |
    | 6334 | 54 | 54 | 54 | 54 |
    | 6336 | 12 | 25 | 25 | 20 |
    | 6338 | 41 | 41 | 41 | 41 |
    | 6341 | 11 | 11 | 11 | 8 |
    | **TOTALE** | **402** | **427** | **447** | **443** |

    Celle impegnate (non centri, su 48×13=624 totali) e precisione su
    quelle impegnate, sommate sui 13 video:

    | Soglia | Impegnate | Corrette | Precisione |
    |---|---|---|---|
    | 4 | 461/624 | 324 | 70,3% |
    | 5 | 470/624 | 349 | 74,3% |
    | 6 | 460/624 | 369 | 80,2% |
    | 8 | 435/624 | 365 | 83,9% |

    La precisione sale in modo monotono con la soglia mentre le celle
    impegnate calano solo leggermente: salire di soglia scarta osservazioni
    peggiori, non riempie a caso — comportamento sano, non il pattern
    caotico della variante A (#11).

    Criterio di adozione per la soglia 6, tutte e 3 soddisfatte: (1) con
    soglia 5 (427) e soglia 8 (443) il totale resta sopra 402; (2) nessuna
    delle soglie 5/6/8 fa scendere un video test di più di 5 caselle
    rispetto alla soglia 4 (tutti i delta sui video test sono ≥0); (3) con
    soglia 6 nessun video peggiora rispetto alla soglia 4 (tutti i delta
    sono ≥0). La soglia 8 non è migliore della 6 (443<447): nessun motivo
    per salire oltre. **Soglia 6 adottata come default di produzione**
    (`GRID_ALIGNMENT_THRESHOLD_DEFAULT` in `lib/video-decoder.ts`).

11. **Variante A: selezione per indice invece di filtro a soglia**
    (`selectByGridAlignmentIndex` in `lib/video-decoder.ts`, dietro flag
    `BENCH_GRID_INDEX_SELECT`: nessuna soglia da tarare, per ogni faccia
    sceglie direttamente l'osservazione-modello con l'indice di
    allineamento griglia più alto del gruppo, al posto del filtro a
    soglia 4 + fusione multi-frame) → **scartata**.

    Bench sui 13 video:

    | Video | Produzione (soglia 4) | Variante A | Δ |
    |---|---|---|---|
    | 6107 | 54 | 54 | 0 |
    | 6108 | 11 | 11 | 0 |
    | 6258 (test) | 54 | 54 | 0 |
    | 6260 (test) | 39 | 46 | +7 |
    | 6281 (test) | 37 | **19** | **−18** |
    | 6297 | 28 | 37 | +9 |
    | 6298 | 30 | 34 | +4 |
    | 6299 | 12 | 20 | +8 |
    | 6300 | 19 | 46 | +27 |
    | 6334 | 54 | 54 | 0 |
    | 6336 | 12 | 12 | 0 |
    | 6338 | 41 | **17** | **−24** |
    | 6341 | 11 | 8 | −3 |
    | **TOTALE** | **402** | **412** | **+10** |

    Il totale sale (412>402) ma **6281 (video test) crolla di 18 caselle**,
    oltre il limite di 5 — criterio di sicurezza fallito, nonostante il
    guadagno aggregato.

    **Motivo misurato, non un'ipotesi**: scegliere sempre la singola
    osservazione con indice più alto del gruppo — anche quando è solo la
    migliore fra letture comunque scadenti — forza una lettura su ogni
    cella invece di lasciarla non impegnata come fa il filtro a soglia.
    Su 6281 questo aumenta le celle impegnate da 31/48 a 43/48 ma fa
    **crollare la precisione dal 100% al 30%** (13/43) — 5 facce su 6
    peggiorano (U 3/3→2/6, R 2/2→2/9, F 7/7→2/7, L 9/9→3/9, B 7/7→2/9).
    Lo stesso identico meccanismo, in direzione opposta, spiega il crollo
    di **6338 (−24, precisione 100%→30%, 35/35→11/37)** e il miglioramento
    di 6300 (+27, precisione 35%→100%, 13/37→40/40): riempire a tutti i
    costi aiuta quando la "migliore fra le cattive" era comunque
    accettabile, affonda quando non lo era — stesso schema di instabilità
    già osservato per gli esperimenti #1-9, qui dentro al meccanismo di
    selezione invece che nel colore.

12. **Diagnosi causale delle caselle non corrette a soglia 6** (non un
    cambio di produzione: `bench/missing-cells-diagnosis.ts`, diagnosi
    solamente). Classifica le 48 caselle non centrali di ogni video sotto
    54/54 (10 dei 13 video) in 7 categorie, verificando che la somma per
    video dia sempre 48.

    | # | Categoria | Totale su 255 non corrette |
    |---|---|---|
    | 2 | vuote — nessuna osservazione/gate modello | 65 |
    | 3 | vuote — salvaguardia filtro allineamento | 17 |
    | 4 | vuote — non impegnate dalla ricostruzione (vincoli/beam) | 82 |
    | 5 | sbagliate — colore su griglia ben allineata (indice≥6) | 26 |
    | 6 | sbagliate — orientamento/rotazione faccia | 24 |
    | 7 | sbagliate — altro | 41 |

    225 caselle corrette su 480.

    **Approfondimento A (categoria 7, 41 celle)**: percorso della lettura
    usata. 28/41 da modello protetto dalla salvaguardia dell'esperimento #10
    (indice sotto soglia, filtro applicato correttamente — voluto); 13/41 da
    nessuna osservazione affatto, valore dedotto dai soli vincoli dei pezzi
    (non una lettura fotometrica sbagliata, una DEDUZIONE sbagliata).
    Controfattuale "soglia 6 anche sulla salvaguardia": le 28 diventerebbero
    vuote invece di sbagliate, ma 14 caselle oggi CORRETTE sulle stesse
    facce diventerebbero vuote anche loro — nessun guadagno netto, confirma
    che la salvaguardia è già nella configurazione giusta. Le 13 non sono
    simulabili (nessun indice geometrico per una deduzione pura).

    **Approfondimento B (categoria 4, 82 celle)**: 77/82 per beam search con
    più stati candidati ugualmente validi (nessuno unico — la cella resta
    vuota per consenso mancante, non per troncamento né per confidenza
    sotto soglia: queste ultime due sotto-cause sono 0/82). 5/82 "altro",
    tutte su IMG_6108.

    **Approfondimento C (categoria 2, 65 celle)**: per faccia, confronto tra
    presenza del colore dentro/fuori la finestra di ispezione individuata e
    tentativi di rilevamento modello (gate ≥6 celle). 30/65 mai rilevate dal
    modello nella finestra pur essendo presenti; 11/65 rilevate ma scartate
    dal gate; 24/65 un'anomalia misurata (il modello ha superato il gate in
    qualche passata della pipeline — fino a 54 volte — ma la faccia resta
    comunque vuota nello stato finale): il tally dei tentativi copre TUTTO
    il run (scansione di confine + passate di fusione successive, intervalli
    più larghi della finestra finale), quindi non distingue un successo
    dentro la finestra finale da uno fuori — prossimo passo di misura, non
    ancora un'causa isolata. Nessuna faccia è risultata "finestra sbagliata"
    pura con la soglia di presenza-colore usata (4%), ma **IMG_6108
    (26,94–28,70 s su 44,99 s di video) resta un caso a parte**: finestra di
    soli 1,76 s, a oltre metà video, un netto outlier rispetto a tutti gli
    altri video del bench (tutti con finestra 0–1,2 s); le facce U e L non
    hanno nessun tentativo di rilevamento nella finestra, con presenza di
    colore più alta PRIMA della finestra che dentro (U: 15,8% prima vs 5,8%
    dentro). Plausibile che l'euristica di segmentazione
    (`inferVideoSegmentation`/`inferInspectionEnd`) abbia scelto la finestra
    sbagliata per questo video.

    **Piste ordinate per caselle recuperabili stimate** (nessuna implementata,
    solo diagnosi):
    1. Beam search non univoco (B, ~77 celle) — scartata come prima pista:
       stesso schema di rischio della variante A (#11), "riempire forzando
       una scelta fra ambigui" ha già fatto collassare la precisione altrove.
       **Verificato direttamente con le letture fotometriche nell'esperimento
       #13: confermato, non recuperabile in modo automatico.**
    2. Finestra di ispezione su IMG_6108 (~23 celle, U+L+B su un solo video)
       — **prima pista da tentare**: non tocca fusione/colore (area di tutti
       gli esperimenti #1-9 scartati), è isolata e ben evidenziata dai dati
       (outlier netto su durata/posizione finestra). Piano: raccogliere
       altri video con lo stesso pattern (finestra breve e tardiva rispetto
       alla durata) prima di toccare l'euristica; se confermato, aggiustare
       `inferInspectionEnd` solo per quel pattern. Criterio di successo:
       totale sopra 447/702, nessun video test giù di più di 5, IMG_6108 sale
       senza che nessun altro video peggiori.
    3. Rilevamento modello mancante in finestra (C, 30 celle) e anomalia di
       ambito boundary-scan/finestra finale (C, 24 celle) — richiedono prima
       uno strumento di misura più preciso (tally del gate con timestamp,
       filtrato alla finestra finale) prima di poter proporre un intervento.
    4. Salvaguardia dell'esperimento #10 (A, 28 celle) — nessuna azione:
       il controfattuale mostra che è già nella configurazione corretta.

    Dati completi: `bench/results/missing-cells-diagnosis.json`.

13. **Le celle ambigue del beam search si possono risolvere con le letture
    fotometriche?** (non la variante A #11: qui gli stati candidati sono
    GIÀ tutti fisicamente validi, non si forza l'uso di un singolo
    fotogramma — si tratta solo di scegliere fra candidati validi con
    l'evidenza fotometrica. Diagnosi solamente,
    `bench/beam-ambiguity-photometric.ts`, nessuna modifica alla pipeline.)

    Punteggio per candidato, sulle sole celle dove i candidati completi
    trovati dal beam search differiscono: per ogni osservazione-modello che
    ha superato il filtro di allineamento con indice ≥ 6 (non la
    salvaguardia) e per ogni cella ambigua che quell'osservazione ha letto,
    +confidenza (0-100, CIEDE2000) se il colore dell'osservazione coincide
    con quello del candidato, -la stessa confidenza se non coincide; somma
    su tutte le osservazioni e tutte le celle ambigue.

    9/13 video hanno almeno un caso ambiguo, 133 celle ambigue totali (un
    soprainsieme delle 77 di sotto-causa 1 dell'esperimento #12: qui si
    contano tutti i disaccordi fra candidati completi, anche dove nessuna
    singola osservazione aveva mai letto la cella).

    | Video | Candidati | Troncato | Rango stato vero | Margine 1°-2° | Recuperate | Sbagliate |
    |---|---|---|---|---|---|---|
    | 6260 (test) | 2 | sì | 1° | 1080,0 | 4 | 0 |
    | 6281 (test) | 100 | sì | 23° | 0,0 | 13 | 4 |
    | 6297 | 60 | sì | non presente | 428,0 | 3 | 15 |
    | 6298 | 48 | sì | non presente | 0,0 | 7 | 15 |
    | 6299 | 36 | sì | non presente | 514,0 | 3 | 9 |
    | 6300 | 41 | sì | non presente | 0,0 | 12 | 9 |
    | 6336 | 36 | sì | non presente | 0,0 | 3 | 12 |
    | 6338 | 29 | sì | 10° | 0,0 | 7 | 6 |
    | 6341 | 36 | sì | non presente | 0,0 | 2 | 9 |
    | **TOTALE** | | | **1/9 al 1°** | | **54** | **79** |

    Scegliendo sempre il 1° candidato: **54 celle recuperate ma 79
    diventerebbero sbagliate — netto negativo**. Lo stato vero è 1° in
    1/9 casi, non è fra i candidati trovati in **6/9** (correzione: non
    5 come scritto nella prima stesura — 6297, 6298, 6299, 6300, 6336,
    6341). Margine 1°-2° correlato con la correttezza ma inutilizzabile:
    accuratezza 100% solo sopra margine 1080 (**1 solo caso, 4 celle** —
    ben sotto la soglia di 20 richiesta), già 50% sopra margine 514, 11%
    su tutti i 9 casi.

    **Esito: pista chiusa per la parte automatica** (nessuna soglia di
    margine raggiunge insieme ≥95% di accuratezza e ≥20 celle
    recuperabili senza nuovi errori — il criterio di adozione dichiarato in
    partenza non è soddisfatto, non si propone nessun bench di produzione).

    **Approfondimento (`bench/beam-truncation-check.ts`): perché lo stato
    vero manca in 6/9 casi — troncamento o caselle impegnate sbagliate?**
    Per ciascuno dei 6 casi: il troncamento (`sawTruncation`) è risultato
    **true in tutti e 6**; le caselle impegnate (unanimi fra tutti i
    candidati trovati) che contraddicono la verità variano da 1 (6300) a
    32 (6341):

    | Video | Troncato | Caselle impegnate sbagliate | Dopo rimozione: candidati | Stato vero presente dopo? |
    |---|---|---|---|---|
    | 6297 | sì | 8 | 144 | no |
    | 6298 | sì | 2 | 48 | no |
    | 6299 | sì | 22 | 36 | no |
    | 6300 | sì | 1 | 52 | no |
    | 6336 | sì | 14 | 30 | no |
    | 6341 | sì | 32 | 264 | no |

    **Conclusione per ciascuno dei 6: entrambi** (troncamento + caselle
    impegnate sbagliate), non uno dei due isolatamente. Anche rimuovendo
    SOLO le letture impegnate sbagliate identificate e rilanciando la
    ricerca, lo stato vero resta assente in tutti i 6 casi: il troncamento
    non è un dettaglio accessorio del run originale, gioca un ruolo reale
    (la ricerca, anche depurata da quegli errori, non raggiunge comunque lo
    stato vero entro i limiti di `beamWidth`/numero di candidati). La
    diagnosi #12 ("troncamento 0/82") e questo risultato non si
    contraddicono: #12 classificava la causa dell'assenza di una singola
    CASELLA già trovata come candidata ambigua (disaccordo fra gli stati
    TROVATI), mentre qui la domanda è diversa — perché lo STATO VERO non è
    fra quelli trovati. Sono due livelli diversi: il primo non richiedeva
    mai il troncamento perché operava dentro l'insieme già trovato; il
    secondo mostra che quell'insieme stesso, anche corretto delle letture
    sbagliate note, non include la verità per limiti di ricerca.

    **Disambiguazione interattiva valutata su tutti i 9 casi** (correzione
    della metrica "1,56 domande medie" della prima stesura di questo
    esperimento: quella simulazione non distingueva "arriva allo stato
    vero" da "le risposte vere azzerano l'insieme dei candidati trovati" —
    i due esiti hanno lo stesso aspetto, pochi passi, ma significati opposti):

    | Video | Esito | Domande | Celle ambigue |
    |---|---|---|---|
    | 6260 (test) | successo | 1 | 4 |
    | 6281 (test) | successo | 2 | 17 |
    | 6338 | successo | 3 | 13 |
    | 6298 | convergenza-errata | 3 | 22 |
    | 6297 | contraddizione | 1 | 18 |
    | 6299 | contraddizione | 1 | 12 |
    | 6300 | contraddizione | 1 | 21 |
    | 6336 | contraddizione | 1 | 15 |
    | 6341 | contraddizione | 1 | 11 |

    **Così com'è oggi, porterebbe allo stato vero in 3/9 casi** (6260,
    6281, 6338 — esattamente i 3 dove lo stato vero era già presente fra i
    candidati trovati). Negli altri 6: **5/9 vanno in contraddizione** (la
    prima risposta vera dell'utente è già incompatibile con OGNI candidato
    trovato dal beam search) e **1/9 (6298) converge a un unico candidato
    che non è quello vero** — l'esito più insidioso, perché un'interfaccia
    naive lo presenterebbe come "risolto" con falsa sicurezza.

    **Proposta per rilevare e gestire la contraddizione (solo proposta, non
    implementata)**: dopo ogni risposta dell'utente, filtrare i candidati
    trovati dal beam search per quella risposta; se l'insieme risultante è
    vuoto, non proseguire con altre domande (il problema non è nella
    cella appena chiesta, ma in una o più caselle GIÀ impegnate prima
    dell'interazione). Mostrare all'utente esattamente quali caselle già
    impegnate sono in conflitto: per ciascuna delle caselle unanimi fra i
    candidati pre-esistenti, verificare se è compatibile con la risposta
    appena data (stesso controllo di `pieceEvidenceValid`/vincoli dei pezzi
    usato internamente dal beam search) e segnalare quelle incompatibili
    come "da riverificare" invece di incolpare la domanda corrente. Questo
    richiede comunque la stessa cautela di #11/#13: non proporre di
    "forzare" una correzione automatica di quelle caselle, solo di
    segnalarle con una richiesta di verifica umana. Criterio di successo
    per un'eventuale implementazione futura (non proposta qui, serve prima
    capire quali caselle impegnate tendono a essere quelle sbagliate - vedi
    pista aperta sotto): l'interfaccia non deve mai mostrare un singolo
    stato come "risolto" quando è il caso 6298 (convergenza-errata).

    Dati completi: `bench/results/beam-ambiguity-photometric.json` e
    `bench/results/beam-truncation-check.json`.

14. **La ricerca si ferma prima di trovare lo stato vero per mancanza di
    budget?** (solo diagnosi, `bench/beam-budget-check.ts` +
    `bench/beam-budget-worker.ts`, nessuna modifica alla pipeline di
    produzione — il moltiplicatore di budget è letto da un global assente
    in produzione, default 1, comportamento bit-identico.)

    **Catalogo dei limiti di budget** (`lib/inspection-state.ts`):

    | Limite | Riga | Valore base |
    |---|---|---|
    | seedPool (`fuseFaceObservationCandidates`) | 552-557 | 72 |
    | hypotheses per faccia (chiamata con `limit=18`) | 1445 | 18 |
    | `beamWidth` / `maximumRotationCombinations` | 1557-1558 | 1600 |
    | `validStatesMainCap` nel loop principale | 1652 | 256 |
    | `enumeratePieceAssignments` corners/edges (via `completePartialFacelets`) | 995 | 768 |
    | `completePartialFacelets` limit principale (default) | 980 | 96 |
    | ramo di rilassamento (non attivo nei 6 casi: `validStates.size` è sempre >0) | 1598, 1616, 1637, 1667-1669 | 14 / 18 / 520 / 3+36+320 |

    **Quali limiti sono stati raggiunti nei 6 casi, a budget di produzione
    (x1)**: **nessuno**. In tutti e 6 `mainLoopStopReason` è
    `esaurito-senza-limiti` — la ricerca esaurisce da sola gli stati
    fisicamente validi raggiungibili (da 0 a 448 combinazioni esplorate)
    ben prima di toccare `beamWidth` (1600) o `validStatesMainCap` (256).
    `completePartialFaceletsMainCalls` e i cap di `enumeratePieceAssignments`
    non vengono mai raggiunti. Il ramo di rilassamento non si attiva mai
    (richiede `validStates.size===0`, qui sempre >0).

    **Parti 2 e 3 — rilancio a budget ×1/×4/×16/illimitato**, sia sulla
    produzione reale sia dopo aver tolto le caselle impegnate sbagliate
    (nessun timeout: il più lento è stato 14 secondi, IMG_6341 a budget
    illimitato senza le letture sbagliate, 456.192 stati validi esplorati):

    | Video | Produzione, candidati (x1→illimitato) | Senza letture sbagliate, candidati (x1→illimitato) | Vero presente, in NESSUN caso |
    |---|---|---|---|
    | 6297 | 60 → 60 | 144 → 144 | no |
    | 6298 | 48 → 48 | 48 → 48 | no |
    | 6299 | 36 → 36 | 36 → 36 | no |
    | 6300 | 41 → 41 | 52 → 52 | no |
    | 6336 | 36 → 36 | 30 → 30 | no |
    | 6341 | 36 → 36 | 264 → 456.192 | no |

    Alzare il budget **non cambia mai** il numero di candidati sulla
    produzione reale (il collo di bottiglia non è lì): la ricerca ha già
    esplorato tutto lo spazio raggiungibile a budget x1. Anche dopo aver
    rimosso le letture sbagliate, il budget più alto fa crescere di molto i
    candidati su IMG_6341 (264→456.192) ma **mai** fa apparire lo stato
    vero, in nessuno dei 6 casi, in nessuna delle due varianti.

    **Esito: lo stato vero non compare mai.** Nessuna delle due condizioni
    di adozione si applica (non "alza il budget", non "sono solo le
    letture sbagliate note").

    **Ipotesi, con dato a supporto**: rimuovere solo le caselle impegnate
    sbagliate *identificate in un round* (quelle unanimi fra TUTTI i
    candidati trovati nella produzione reale) è una correzione di primo
    ordine. Il dato che la esclude come causa completa: a budget
    illimitato e letture rimosse, la ricerca esplora comunque centinaia o
    decine di migliaia di stati fisicamente validi (fino a 456.192 per
    6341) senza mai incontrare quello vero — non è un problema di tempo di
    ricerca (sempre sotto i 15 secondi), è che il vero stato non è
    raggiungibile dai vincoli dei pezzi applicati alle letture RESIDUE.
    Ipotesi più probabile: ci sono letture sbagliate ULTERIORI, non unanimi
    nella produzione reale (quindi non rilevate dal metodo "unanimi fra i
    candidati trovati"), che diventano un ostacolo solo DOPO che il primo
    round di correzioni ha aperto nuovi rami di ricerca — un effetto a
    cascata che un solo round di rimozione non cattura. Cross-riferimento
    con le categorie della diagnosi #12 per le celle rimosse in questo
    esperimento: IMG_6297 100% categoria 7 (altro), IMG_6298 100% categoria
    6 (rotazione), IMG_6299 41% cat.5/23% cat.6/36% cat.7, IMG_6300 100%
    cat.7, IMG_6336 7% cat.5/36% cat.6/57% cat.7, IMG_6341 28% cat.5/37%
    cat.6/34% cat.7 — nessuna categoria dominante univoca, coerente con
    l'ipotesi di errori sparsi e concatenati piuttosto che un singolo
    meccanismo isolabile.

    Dati completi: `bench/results/beam-budget-check.json`.

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
reso tutti i tentativi precedenti instabili — risultato coerente su 5
soglie diverse (3, 4, 5, 6, 8), nessuna regressione sul gruppo test. La sua
variante A (#11, scegliere sempre la singola osservazione più allineata
invece di filtrare per soglia) ricade invece nello stesso schema caotico:
il meccanismo non è la geometria in sé, ma il MODO in cui la si usa — una
soglia che lascia celle non impegnate è stabile, forzare una lettura
ovunque no.
