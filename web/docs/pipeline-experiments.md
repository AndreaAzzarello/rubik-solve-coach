# Esperimenti sulla pipeline di ricostruzione (ottobre 2026)

Bench di riferimento: 13 video (`bench/cases.json`) — 3 "test" mai visti dal
modello (IMG_6258/6260/6281, le sole decisive per cambi di MODELLO), 2
"integration" (IMG_6107/6108), 8 "seen" usati in training. Baseline storica
(esperimenti #1-9) = 359/702 (gruppo test 130/162: 6258=54, 6260=39,
6281=37). Dopo l'adozione dell'esperimento #10 (soglia 6) = 447/702, gruppo
test 141/162 (6258=54, 6260=50, 6281=37). **Baseline attuale (dopo
l'adozione dell'esperimento #16, Passo 2 + Passo 3) = 462/702**, gruppo
test 155/162 (6258=54, 6260=49, 6281=52).

Ogni riga: cosa è stato provato → risultato sui 13 video → perché è stato
scartato (o adottato). Gli esperimenti #10 e #16 sono in produzione; tutti
gli altri no.

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

15. **Test di sanità: con un input perfetto (nessun video, nessun errore di
    lettura), la ricerca trova sempre lo stato vero?** (solo diagnosi;
    aggiunge pero' un test automatico permanente, vedi sotto. Nessuna
    modifica alla pipeline di produzione.)

    Premessa logica verificata in questo esperimento: se l'input della
    ricerca contiene SOLO letture compatibili con la verità, una ricerca
    che esplora tutto lo spazio fisicamente valido deve sempre includere lo
    stato vero. Nell'esperimento #14 questo non succede mai (nemmeno con
    456.192 candidati su 6341): quindi o la rimozione delle letture
    sbagliate era incompleta, o c'è un bug nella ricostruzione stessa.

    **Test 1 (oracolo sintetico, nessun video)**: per i 13 scramble di
    `bench/cases.json`, genera lo stato vero con `CubeState.facelets()` (le
    stesse funzioni di produzione: `CANONICAL_FACE_COLOR`,
    `reconstructInspectionState`) e costruisce osservazioni "perfette"
    (confidenza 95, nessun errore):

    | Variante | Copertura | Esito |
    |---|---|---|
    | 1a — tutte le 48 caselle | 9/9 per faccia | **13/13 passano**: ricostruzione identica alla verità (`complete`, 54/54) |
    | 1b — 5 facce complete, 1 assente (a rotazione tra le 6) | 9/9 su 5 facce | **13/13 passano**: stato vero sempre fra i candidati (spesso `complete`) |
    | 1c — 30/48 caselle casuali (seed dichiarato 20261012, ~5 celle/faccia in media) | sparsa | **FALLISCE in 6/13**: 6108, 6281, 6299, 6334, 6338, 6341 |

    **Il test 1 fallisce (variante 1c): è un bug, non solo un problema di
    dati reali.** Funzione e riga responsabili:
    `enumeratePieceAssignments` (`lib/inspection-state.ts:796`, troncamento
    a riga 825, cap 768 per corner/edge) e `completePartialFacelets`
    (`lib/inspection-state.ts:995`, troncamenti a righe 1005 e 1010, cap
    96 sul combinato corner×edge). Con copertura sparsa (variante 1c, media
    ~5 celle/faccia) e `orientationConfidence` non impostata (ogni faccia
    prova tutte le 4 rotazioni, per costruzione del test — scelta
    deliberata: isolare l'effetto della sparsità, non della rotazione),
    le combinazioni angolo/spigolo fisicamente valide superano spesso il
    cap prima che venga raggiunto un qualsiasi limite di `beamWidth`
    (1600) o `validStatesMainCap` (256) — confermato dalla telemetria budget
    sui 6 casi falliti: `rotationCombinationsAtStop` è sempre minuscolo (1-
    13), ben sotto 1600, mentre `completePartialFaceletsMainTruncatedCount`
    e/o `edgesAssignments768TruncatedCount` sono quasi sempre ≥1. La
    causa non è la mancanza di budget (esperimento #14 l'aveva già
    escluso): è che `enumeratePieceAssignments`/`completePartialFacelets`
    enumerano i completamenti in un ordine ARBITRARIO (depth-first,
    posizioni ordinate per minor numero di opzioni — un'euristica di
    efficienza del backtracking, non di correttezza) e si fermano al cap
    SENZA alcuna preferenza per i completamenti coerenti con l'evidenza
    disponibile. Con poca evidenza le combinazioni valide sono molte, e lo
    stato vero (garantito compatibile per costruzione in questo test) può
    restare semplicemente fuori dal campione arbitrario che il cap lascia
    passare.

    **Correzione proposta (non implementata)**: durante l'enumerazione in
    `enumeratePieceAssignments`, ordinare le opzioni per posizione secondo
    la loro coerenza con l'evidenza fotometrica NON ancora impegnata in
    `partial` (le letture disponibili ma scartate/a bassa confidenza),
    così che il campione tagliato dal cap sia quello più plausibile invece
    che il primo trovato in ordine arbitrario; oppure, più semplice e meno
    rischioso, rilassare SOLO il cap di `completePartialFacelets` (96→più
    alto) quando il numero di caselle note è sotto una soglia (es. <40/48)
    — la stessa famiglia di "piste pericolose" già viste (#1-9, #11):
    aumentare la copertura senza un criterio di correttezza può introdurre
    instabilità altrove, quindi qualunque correzione andrebbe validata con
    lo stesso bench completo (totale sopra 447/702, nessun video test giù
    di più di 5) prima di essere adottata.

    **Test 1 aggiunto come test automatico permanente**
    (`lib/inspection-state.test.ts`, `pnpm run test:inspection`): le
    varianti 1a e 1b sono assert pieni (bloccano la build se regrediscono);
    la variante 1c è marcata `{ todo: ... }` — gira a ogni esecuzione e
    resta visibile nell'output, ma un suo fallimento non rompe la CI,
    perché documenta un bug noto non ancora corretto, non una regressione
    nuova.

    **Test 2 (oracolo sui video reali) non eseguito**: la richiesta lo
    prevedeva solo nel ramo "il test 1 passa"; il test 1 fallisce, quindi
    per l'albero di decisione dichiarato la diagnosi si ferma qui.

16. **Correzione del bug trovato nel #15** → **ADOTTATO** (Passo 2 + Passo 3,
    mersato su `main` dal branch `exp/beam-truncation-fix`).

    **Passo 1 (conferma della causa)**: rilanciata la variante 1c con i cap
    768/`enumeratePieceAssignments` e 96/`completePartialFacelets`
    rimossi davvero (`benchBudgetMultiplier=Infinity`, verificato nel
    codice che sono quelli sul percorso: telemetria
    `cornersAssignments768TruncatedCount`/`edgesAssignments768TruncatedCount`/
    `completePartialFaceletsMainTruncatedCount` tutte a 0 col cap rimosso).
    **13/13 passano** (peggior tempo 524ms, IMG_6108, 34.884 candidati) →
    la causa è il troncamento, non un errore nei vincoli/potatura: nessun
    bug di logica da isolare, si procede al Passo 2.

    Perché nel #14 il budget "illimitato" non cambiava i candidati sui 6
    video reali: lo stesso `benchBudgetMultiplier` moltiplica anche questi
    due cap (erano quindi **inclusi**), ma la telemetria del #14 mostrava
    già `completePartialFaceletsMainTruncatedCount≈0` sui video reali A
    BUDGET NORMALE — il troncamento di questa funzione semplicemente non
    era il collo di bottiglia *per quei 6 video*: la ricerca si esauriva
    da sola perché le letture sbagliate committed eliminavano il ramo
    giusto prima ancora di avvicinarsi a qualunque cap. Il bug del #15 e la
    diagnosi del #14 convivono: due meccanismi diversi, il primo visibile
    solo con evidenza sparsa ma internamente coerente (l'oracolo sintetico),
    il secondo con letture reali contaminate.

    **Passo 2 (correttezza prima delle prestazioni)**: in
    `reconstructInspectionState`, quando la ricerca è troncata
    (`sawTruncation`), una casella "unanime fra tutti i candidati TROVATI"
    non è detto sia unanime fra tutti gli stati fisicamente validi — misurato
    dal vivo: su IMG_6108 (oracolo 30/48), **20 caselle** risultavano unanimi
    solo nel campione troncato (288 candidati) e non più rilanciando senza
    cap (34.884 candidati). Corretto: quando `sawTruncation`, `facelets`
    non usa più `candidateConsensus`/il candidato singolo, ma solo
    `bestPartial` (osservazioni dirette + inferenze forzate dai pezzi,
    esaustive per costruzione su un elenco fisso di 8 angoli/12 spigoli,
    mai soggette al troncamento dell'enumerazione dei completamenti).
    Nuovo test (`lib/inspection-state.test.ts`): nessuna casella
    sbagliata-ma-certa sulle stesse 13 osservazioni sparse del test 1c.

    **Passo 3 (il Passo 2 da solo non basta a far passare la 1c, come
    previsto)**: soluzione più semplice che fa passare il test — cap di
    `completePartialFacelets` (96) ed `enumeratePieceAssignments` (768)
    alzati **256×** (trovato per tentativi: a 128× resta 1 caso su 13
    sotto cap, a 256× tutti passano). Costo nel caso peggiore fra i 13
    scramble: **241ms** di puro calcolo Node (IMG_6108) — una frazione
    trascurabile dei ~100s di analisi video attuali, ben sotto il limite
    di +50%. Il ramo di rilassamento (raro, mai attivo nei casi
    diagnosticati) resta al cap originale 768, passato esplicitamente, per
    non cambiarne il costo nel caso raro in cui scatta.

    **Passo 4 (bench sui 13 video, branch `exp/beam-truncation-fix`)**:

    | Run | Totale | Gruppo test | Tempo medio analisi |
    |---|---|---|---|
    | Baseline odierna (soglia 6) | 447/702 | 141/162 (6258=54,6260=50,6281=37) | ~100-120s |
    | Passo 2 da solo | **462/702** | **155/162** (6258=54,6260=49,6281=52) | 112s |
    | Passo 2 + Passo 3 | **462/702** (identico) | **155/162** (identico) | 109s |

    Il Passo 3 non cambia NULLA sui 13 video reali (stesso totale, stesso
    tempo nel rumore di misura): confermato che il suo effetto è specifico
    all'evidenza sparsa dell'oracolo sintetico, non a questo dataset.

    Delta per video (correct/sbagliate/vuote, oggi → dopo il Passo 2):

    | Video | Gruppo | Oggi (corrette/sbagliate/vuote) | Dopo (corrette/sbagliate/vuote) | Δ corrette |
    |---|---|---|---|---|
    | 6107 | integration | 48/0/0 | 48/0/0 | 0 |
    | 6108 | integration | 5/12/31 | 5/12/31 | 0 |
    | 6258 | test | 48/0/0 | 48/0/0 | 0 |
    | 6260 | test | 44/0/4 | 43/0/5 | −1 |
    | 6281 | test | 31/0/17 | 46/0/2 | **+15** |
    | 6297 | seen | 22/8/18 | 22/6/20 | 0 |
    | 6298 | seen | 24/2/22 | 24/2/22 | 0 |
    | 6299 | seen | 14/22/12 | 8/17/23 | **−6** |
    | 6300 | seen | 26/1/21 | 31/4/13 | +5 |
    | 6334 | integration/seen | 48/0/0 | 48/0/0 | 0 |
    | 6336 | seen | 19/14/15 | 21/16/11 | +2 |
    | 6338 | seen | 35/0/13 | 36/0/12 | +1 |
    | 6341 | seen | 5/32/11 | 4/24/20 | −1 |

    Criterio di adozione dichiarato (**totale sopra 447/702 e nessun video
    test giù di più di 5**): **entrambe soddisfatte** (462>447; 6260 −1,
    6281 +15, 6258 invariato — nessun video test scende). Il totale non è
    sceso (la clausola "non scartare se il totale scende" non si applica),
    ma **6299 (gruppo "seen") peggiora su entrambi gli assi**: correct
    14→8 e precisione sulle caselle impegnate 38,9%→32% (14/36 → 8/25) —
    non il pattern "precisione su, copertura giù" atteso dal Passo 2, un
    effetto diverso (probabile ambiguità di rotazione nella sua
    `bestPartial` su dati reali non sintetici, fuori dal controllo di
    questo esperimento). 6341 e 6260 scendono di 1 casella ciascuno.

    **Adottato su `main`** dopo revisione esplicita della regressione
    isolata su 6299 (diagnosticata separatamente, vedi sotto): il criterio
    numerico dichiarato è soddisfatto (462>447, nessun video test giù) e il
    miglioramento aggregato e sul gruppo test è netto. 6299 resta un caso
    peggiorato, accettato consapevolmente.

    Test 1c (esperimento #15) promossa da `{ todo }` ad assert pieno:
    dopo il Passo 3 passa stabilmente (13/13).

    Dati completi: `bench/results/exp16-passo2-only.json`,
    `bench/results/exp16-passo2-plus-passo3.json`.

    **Perché 6299 peggiora (corrette 14→8, precisione 38,9%→32%)** — solo
    diagnosi (`bench/img6299-regression-check.ts`), nessuna correzione
    implementata.

    17 caselle cambiano: 6 erano corrette e sono diventate vuote (U0, U3,
    R8, B5, B6, B7 — il costo accettato del Passo 2, caselle presenti solo
    via `candidateConsensus`/candidato singolo, non in `bestPartial`), 8
    erano sbagliate e sono diventate vuote (miglioramento), 3 erano vuote e
    sono diventate sbagliate (U6, F7, L2 — tutte da inferenza forzata dai
    pezzi, nessuna da osservazione diretta).

    **Ipotesi rotazione confermata per F e L**: ruotando le sole letture
    dirette osservate (senza toccare nulla nel codice) il confronto con la
    verità sale da 0 a 3/5 caselle per F (180°) e da 0 a 5/8 per L (180°).
    Entrambe le facce risultano ruotate di 180° rispetto al vero
    orientamento. Il builder delle rotazioni per faccia
    (`lib/inspection-state.ts`, dentro `reconstructInspectionState`) mostra
    **margine 0,0 fra la prima e la seconda rotazione per TUTTE le 6
    facce** di questo video — non è un'anomalia isolata, è sistematico qui.

    **Causa individuata (limite strutturale, non un errore di logica che
    produce un risultato sbagliato rispetto alle specifiche — una scelta
    "giusta" semplicemente non è definita quando manca il segnale)**:
    `colorLayoutQuality` (riga ~447) dipende solo dall'insieme dei colori
    visibili (un `Set`, indifferente alla posizione); `visibleCells`/
    `confidence`/`sourceFrames` sono proprietà dell'osservazione,
    indifferenti alla rotazione. Quando la confidenza per-cella è uniforme
    (niente celle "più debole" da scartare: `removalPenalty` uguale per
    ogni rotazione), **il punteggio delle 4 rotazioni è matematicamente
    identico per costruzione**. Senza un `orientationConfidence`
    indipendente, la scelta finale dipende dall'ordine di inserimento nella
    `Map`, non dalla correttezza geometrica. Test che lo riproduce in
    isolamento aggiunto in `lib/inspection-state.test.ts` (osservazione
    sintetica a confidenza uniforme → le rotazioni trovate hanno lo stesso
    punteggio).

    Correzione proposta (non implementata): un termine di punteggio
    sensibile alla rotazione calcolabile per singola faccia — per esempio
    un bonus per quante triple d'angolo (faccia + i due vicini visibili
    nella stessa osservazione) coincidono con un angolo reale di
    `CUBIE_COLOR_SCHEMA` — così la preferenza non dipenderebbe più solo
    dall'ordine di inserimento quando confidenza e colori sono uniformi. Da
    validare con lo stesso bench completo prima di adottare (stesso rischio
    delle piste già scartate: "riempire/scegliere in modo diverso" ha
    sempre richiesto una verifica sui 13 video, mai un'intuizione isolata).

    La faccia R, invece, non si spiega con una rotazione (nessuna delle 4
    rotazioni delle letture dirette raggiunge un solo match con la verità):
    è un limite dei dati di 6299, letture di colore sbagliate su R, non un
    problema di orientamento.

17. **Pareggi nella scelta della rotazione delle facce** → **non adottata**
    (codice su branch `exp/rotation-tie-break`, non mersato — solo l'esito
    registrato qui, stesso schema dell'esperimento #11).

    **Passo 1 (misura, 13 video)**: su 67 facce, **65 in pareggio**
    (margine ≤1e-9 fra 1ª e 2ª rotazione candidata) — quasi sempre, non
    l'eccezione. Di queste, **39 con la scelta sbagliata** (non il massimo
    disponibile fra le rotazioni candidate). 0 facce sbagliate senza
    pareggio. Confirma che il problema di #16/6299 è sistemico.

    **Passo 2 (test sintetico permanente)**: oracolo a copertura piena
    (48/48) con ogni faccia ruotata di un multiplo diverso di 90°,
    confidenza uniforme. **Passa già oggi, 0/13 falliscono**, anche senza
    alcuna correzione — con copertura completa i vincoli dei pezzi
    bastano a scartare le combinazioni di rotazione sbagliate. Non
    riproduce il problema reale: il fallimento del #16 (6299) richiede
    copertura PARZIALE, non testata da questo scenario a copertura piena
    (come richiesto esplicitamente dal Passo 2). Test aggiunto
    permanentemente in `lib/inspection-state.test.ts`.

    **Passo 3 (variante A, dietro flag `benchRotationTieBreakVariantA`,
    default false)**: in `considerPartial`
    (`lib/inspection-state.ts`), quando una nuova soluzione pareggia
    (entro 1e-9) la qualità della migliore trovata finora, non si scarta
    né si sostituisce: le caselle in disaccordo vengono erose a null.
    Oltre 64 pareggi fusi si smette (si tiene il consenso eroso, non si
    indovina). Non rompe il test del Passo 2 (13/13 anche attiva).

    **Passo 4 (variante B)**: non implementata — la condizione dichiarata
    ("solo se A non basta a far passare il test sintetico") non si
    applica, il test passa già senza alcuna variante.

    **Passo 5 (bench sui 13 video, variante A)**:

    | Run | Totale | Gruppo test | Tempo medio |
    |---|---|---|---|
    | Baseline (#16) | 462/702 | 155/162 | ~109-112s |
    | Variante A | 462/702 (**identico**) | 155/162 (**identico**) | 111s |

    Confronto cella-per-cella su tutti i 702: **1 sola differenza**,
    IMG_6298/R#1 e R#7 (entrambe da sbagliate a vuote — precisione su,
    nessun costo). Tutti gli altri 12 video, **6299 e 6338 compresi, bit-
    identici**: la variante A non li tocca affatto.

    **Perché non cambia nulla su 6299/6338**: la variante A agisce sul
    pareggio di qualità dell'intero stato a 54 caselle in
    `considerPartial` — un pareggio a quel livello (dopo aver combinato
    tutte le 6 facce) è raro, perché combinazioni diverse di rotazioni
    per faccia producono quasi sempre `sourceScore` complessivi diversi,
    anche quando le rotazioni di UNA faccia pareggiano fra loro al
    Passo 1. **I due pareggi non sono allo stesso livello**: il Passo 1
    misura il pareggio per-faccia (nel builder `choices`, già passato
    inalterato al beam search — tutte le rotazioni pareggiate vengono già
    provate, non scartate), la variante A intercetta solo il pareggio
    dell'intero stato combinato, molto più raro (è scattato una sola
    volta su 13 video). Per intervenire davvero su 6299 servirebbe un
    meccanismo al livello del Passo 1 (per-faccia), non implementato qui.

    **Esito: criterio "totale sopra 462/702" non soddisfatto** (è pari,
    non sopra) e il caso che ha motivato l'esperimento (6299) resta
    invariato. Nessuna regressione su nessun video. **Non adottata**:
    nessun beneficio misurabile a fronte della complessità aggiunta;
    riportato, fermo qui.

    Dati completi: `bench/results/rotation-tie-check.json`,
    `bench/results/exp17-variantA.json` (branch `exp/rotation-tie-break`).

18. **Chi decide l'orientamento sbagliato, se i pareggi per-faccia passano
    intatti alla ricerca?** (solo diagnosi, nessuna modifica alla
    produzione — su `main`, nessun branch: nessun codice di produzione
    toccato.)

    **Parte 1 — tracciato di 5 delle 39 facce sbagliate**
    (`bench/rotation-decisive-trace.ts`): riusa gli hook solo-bench già
    presenti (`__benchChoicesDiag`, `__benchCandidateStatesDiag`,
    `__benchPartialDiag`), nessuna nuova strumentazione.

    | Caso | Candidati completi | Faccia univoca fra i candidati? | Match finale |
    |---|---|---|---|
    | 6258/U | 1 | sì (unico) | 8/8 ✓ |
    | 6281/L | 100 | sì (tutti d'accordo) | 8/8 ✓ |
    | 6299/U | 36 | **no, 27 varianti disaccordano** | 0/8 |
    | 6338/F | 29 | **no, 29 varianti disaccordano** | 2/8 |
    | 6108/R | 0 (nessun candidato completo) | n/a | 3/8 |

    **Due esiti distinti dallo stesso pareggio iniziale**: su 6258/U e
    6281/L il pareggio per-faccia non conta — i vincoli dei pezzi delle
    ALTRE facce, applicati a TUTTI i candidati completi trovati,
    convergono comunque sulla faccia corretta (`pieceEvidenceValid`/
    `colorCountValid`, `lib/inspection-state.ts`, funzionano come
    previsto). Su 6299/U e 6338/F i candidati completi **disaccordano**
    su questa faccia anche dopo tutti i vincoli: la scelta finale passa a
    `bestPartial`, costruito da `considerPartial`
    (`lib/inspection-state.ts:1618`) con un criterio preciso — la PRIMA
    combinazione che supera STRETTAMENTE (`>`, mai `>=`) la qualità
    migliore vista finora vince e resta, in un ordine di iterazione fisso
    (facce in ordine `CUBE_FACES`, ipotesi per faccia nell'ordine di
    `fuseFaceObservationCandidates`, rotazioni in ordine 0→1→2→3); un
    pareggio esatto di qualità NON sostituisce mai quella già tenuta — mai
    verificato contro il consenso dei candidati completi trovati
    successivamente. Su 6108/R, senza nemmeno un candidato completo,
    `bestPartial` è l'UNICA fonte, con lo stesso criterio.

    **Criterio quindi**: non i vincoli dei pezzi (che qui non bastano),
    non un punteggio geometrico consapevole della rotazione — **ordine di
    iterazione + "primo che supera, mai chi pareggia dopo"**, esattamente
    come ipotizzato.

    **Parte 2 — oracolo ruotato a copertura parziale (30/48, seed
    20261012)** (`bench/rotation-partial-oracle-check.ts`, puro Node,
    nessun browser): **8 orientamenti finali sbagliati E impegnati**
    (IMG_6108: U, L, B; IMG_6299: R, F, D, L, B) su 78 facce testate; **9
    facce con evidenza ma correttamente lasciate aperte** (il Passo 2
    dell'esperimento #16 già protegge QUESTI casi). La quota sbagliata-e-
    impegnata è reale ma non assoluta: quasi metà delle facce ambigue
    trovate qui sono già gestite in modo sicuro oggi.

    **Parte 3 — evidenza geometrica multi-faccia**
    (`bench/geometric-neighbor-check.ts`): sulle 39 facce sbagliate
    dell'esperimento #17, solo **7/39 (18%) hanno almeno un fotogramma
    con una faccia adiacente rilevata insieme** (`bundleSize>=2`); le
    altre 32 non hanno MAI avuto l'opportunità geometrica. Delle 7 con
    fotogramma multi-faccia, **0/7 hanno ricevuto una correzione**: la
    funzione che userebbe questa evidenza esiste già ed è già chiamata
    oggi — `normalizeObservationOrientations`
    (`lib/inspection-state.ts:362`, invocata all'inizio di
    `reconstructInspectionState`) — ma in tutti i 7 casi il punteggio
    geometrico (`sideFromNeighbor`) non supera le soglie già presenti nel
    codice (`best.score < 0.35 || margin < 0.12`, riga 399): un singolo
    fotogramma multi-faccia raramente basta, la co-rilevazione di due
    facce in uno stesso crop è rara E quando capita è quasi sempre
    un'istanza isolata, non abbastanza per superare la soglia di
    confidenza già prudente. **L'evidenza geometrica non è la leva
    giusta per questi 39 casi**: è già usata, ma i dati non la alimentano
    a sufficienza.

    **Proposta finale (non implementata)**, due regole:

    1. **Se i vincoli non decidono, la faccia resta aperta.** Oggi, nella
       costruzione di `displayFacelets`
       (`lib/inspection-state.ts`, intorno a `provisionalDisplay`), il
       consenso fra candidati completi (`candidateConsensus`, già nulla
       le caselle in disaccordo) viene usato SOLO quando `!sawTruncation`
       — ma `sawTruncation` è quasi sempre vero con dati reali rumorosi
       (confermato: tutti i 5 casi della Parte 1 hanno `truncated=true`).
       Quando `sawTruncation` è vero, oggi si salta dritti a `bestPartial`
       senza mai controllarlo contro `candidates`. Correzione: SEMPRE
       (troncato o no), se `candidates.length > 0`, nullare in
       `bestPartial` ogni casella che non coincide con il valore unanime
       fra `candidates` per quella casella — una generalizzazione
       dell'esperimento #16 Passo 2, non una regola nuova. Per il caso
       senza nessun candidato completo (6108/R, `candidates.length===0`,
       nessun riferimento contro cui controllare): usare direttamente
       l'informazione di pareggio già disponibile nel builder `choices`
       (oggi esposta solo all'hook diagnostico `__benchChoicesDiag`) — se
       la faccia aveva un pareggio di punteggio al Passo 1 e nessun
       vincolo l'ha sciolto, nullarla anziché fidarsi del primo trovato.
    2. **Se c'è evidenza geometrica affidabile, si usa** (già vero oggi:
       `normalizeObservationOrientations` pre-ruota e blocca
       `orientationConfidence` PRIMA che `choices` generi ipotesi di
       rotazione — una faccia così bloccata non genera nemmeno un
       pareggio, quindi la regola 1 non la tocca per costruzione). La
       proposta non cambia questo meccanismo, si limita a non interferire
       con esso.

    **Piano di bench** (non eseguito): applicare la regola 1 dietro flag,
    verificare prima che il test della Parte 2 scenda a 0 orientamenti
    sbagliati impegnati (se non basta, la regola 1b sul caso
    `candidates.length===0` va rifinita), poi bench sui 13 video, un run
    alla volta, JSON salvato a ogni run. Criterio di adozione: totale
    sopra 462/702, nessun video test giù di più di 5. Rischio atteso
    (coerente con la storia di questo documento): nullare più caselle
    abbassa quasi certamente la copertura (celle oggi sbagliate ma
    contate come "corrette per caso" diventano vuote) — se il totale
    scende ma la precisione sulle caselle impegnate sale, non scartare:
    riportare e fermarsi, decide l'utente, stesso principio già
    applicato nell'esperimento #16.

    Dati completi: `bench/results/geometric-neighbor-check.json`.

19. **Implementa la proposta dell'esperimento #18 (dietro flag,
    `exp/candidate-consensus`) — scartato dopo il bench sui video reali.**

    Tre forme tentate per la regola 2, in ordine (le prime due scartate
    durante lo sviluppo, prima ancora del bench):
    1. Erosione sulla qualità aggregata di `considerPartial`: non vede i
       pareggi che esistono solo a livello di singola faccia (la qualità
       aggregata li rompe quasi sempre per effetti incidentali su facce
       diverse). 8→3 sull'oracolo sintetico.
    2. Una faccia alla volta (tenendo ferme le altre): non vede
       un'ambiguità condivisa da più facce insieme — misurato su
       IMG_6299, dove 4-5 facce sono in pareggio simultaneo. 8→1 poi
       8→6 secondo il caso.
    3. **Forma definitiva**: enumerazione congiunta di tutte le facce in
       pareggio insieme (`faceRotationAmbiguityGuard`, fino a 4^6=4096
       combinazioni o 200ms), impegna solo le caselle unanimi fra le
       combinazioni fisicamente valide, svuota tutto se nessuna
       combinazione è valida o il budget è superato.

    La forma 3 porta l'oracolo sintetico (facce ruotate 0/90/180/270° +
    30/48 caselle casuali, seed 20261012) da **8 a 0** orientamenti
    sbagliati impegnati, con 4 test aggiuntivi (due sui casi reali della
    diagnosi, due unitari su `faceRotationAmbiguityGuard`) e bit-identico
    a flag spento.

    **Bench sui 13 video (flag acceso): 277/702, contro una baseline di
    462/702 — non adottata.** Non è il calo lieve del criterio "riportalo
    e fermati": 8 video su 13 collassano a `status: insufficient` (0
    caselle impegnate oltre i 6 centri). Delta per video: 6107=0,
    6108=-5, 6258=0, 6260=-43, 6281=0, 6297=-22, 6298=-24, 6299=-8,
    6300=-31, 6334=0, 6336=-12, 6338=-36, 6341=-4. Su **6338** (baseline
    100% di precisione, 36/36 caselle impegnate corrette, nessun problema
    di orientamento) l'intero cubo viene svuotato: prova diretta che il
    meccanismo spara troppo largo. Tempo: bench completo in ~71 minuti,
    nessun rallentamento misurabile (il collasso è di correttezza, non di
    prestazioni).

    **Lezione**: sui video reali il pareggio di punteggio per-faccia
    (`choices`) nasce dalla confidenza uniforme delle celle di
    un'osservazione — comune su riprese ben illuminate, non rara come
    nell'oracolo sintetico (dove è stata costruita apposta per isolare il
    fenomeno) — e di norma, nella pipeline esistente, **viene già
    risolto dai vincoli fisici delle altre facce** durante la ricerca
    piena (è il motivo per cui la baseline arriva a 462/702 nonostante
    questi pareggi esistano da sempre). La regola "nessuna combinazione
    valida → svuota tutto" applicata all'insieme (quasi sempre quasi
    tutte le 6 facce) di facce in pareggio fa collassare l'intero cubo
    per una sola lettura sbagliata altrove, invece di isolare il danno
    alla faccia realmente in dubbio.

    **Non adottata**: codice, test e risultato restano solo sul branch
    `exp/candidate-consensus` (archivio, non cancellato, non unito a
    `main`). Su `main` passa solo il test oracolo ruotato a copertura
    parziale, marcato `todo` con il valore attuale (8) — nessun codice di
    produzione.

    Dati completi: `bench/results/exp19-candidate-consensus.json`
    (branch `exp/candidate-consensus`).

20. **Quanto è fragile la scelta della finestra di ispezione a rumore
    minimo sul segnale di moto? Solo diagnosi, nessuna modifica alla
    pipeline.**

    Motivato da un confronto Mac/Windows a codice identico su IMG_6258:
    decoder, ridimensionamento e modello ONNX identici, ma il segnale di
    moto grezzo (`cubeDifference`) differiva di un fotogramma di
    **4.3348 contro 4.3474** — abbastanza per cambiare il numero di fasi
    della segmentazione (3 contro 2) e quindi la finestra di ispezione
    (3.78-6.87s contro 0.48-14.27s), con impatto drastico sul punteggio
    (34/54 contro 54/54). Sul Mac cambiavano 8 video su 13.

    **Catena delle decisioni discrete** (`lib/video-decoder.ts` salvo
    indicazione): `detectMotionEvents` (soglia di rilevamento picco,
    righe ~794-905) → `inferVideoSegmentation` (fasi scramble/inspection/
    solve, righe ~1723-1836, con `denseFaceTurnStart` righe ~1065-1081) →
    `inferInspectionEnd` (fine della finestra, righe ~1088-1182) →
    orchestrazione in `lib/inspection-pipeline.ts` (righe ~94-127) che
    deriva `intervalStart`/`searchEnd`/`intervalEnd`.

    **Strumento** `bench/window-sensitivity.ts`: per i 13 video del
    bench, un solo passaggio costoso nel browser reale
    (`decodeVideoMotion` + una `scanInspectionFrames` larga, per avere le
    vere griglie-colore), poi 12 prove economiche e pure per video
    (rumore ±1% sul `cubeDifference` di ogni campione + spostamento
    costante di ±1 fotogramma nominale dei tempi di campionamento, semi
    dichiarati `20261013 + video*1000 + prova`), che rieseguono SOLO
    `fuseMotionEvidence → detectMotionEvents → inferVideoSegmentation →
    inferInspectionEnd` (funzioni di produzione reali, nessuna copia).
    Cambio "rilevante" = `intervalStart` o `intervalEnd` spostati oltre
    0.5s, oppure numero di fasi diverso dalla base.

    **Risultato: 10/13 video cambiano in modo rilevante in QUASI OGNI
    prova.** 9/13 video (6107, 6258, 6260, 6298, 6300, 6334, 6336, 6338,
    6341) cambiano in 12/12 prove; 1/13 (6297) in 4/12; solo 3/13 (6108,
    6281, 6299) restano stabili in tutte le 12 prove — ben sotto il
    criterio di adozione "stabile in almeno 12/13" fissato per questo
    esperimento, a conferma diretta del divario osservato fra Mac e
    Windows.

    **Soglia più vicina al filo**: la soglia di rilevamento picco di
    `detectMotionEvents` (`threshold = max(2.6, min(noiseThreshold,
    activityCeiling))`). Il campione più vicino a questa soglia dista, in
    TUTTI e 13 i video senza eccezione, tra lo 0.00% e lo 0.55% della
    soglia stessa (mediana ~0.08%) — molto sotto il rumore di ±1%
    applicato. Causa strutturale: `activityCeiling` è il valore di un
    campione reale preso per rango di percentile (non un'interpolazione
    morbida), quindi la soglia finisce quasi sempre esattamente appoggiata
    su un campione vero, non in una zona franca.

    **Correzione proposta, NON implementata** (da verificare prima
    dell'adozione secondo il criterio sotto):
    - `detectMotionEvents`: interpolare `activityCeiling` fra i due
      campioni adiacenti al rango invece di scegliere un campione intero,
      per smettere di appoggiare la soglia esattamente su un valore
      osservato; aggiungere un margine d'isteresi minimo fra `threshold`
      e il campione più vicino prima di impegnare o scartare un picco.
    - `inferVideoSegmentation`: richiedere un margine (non un semplice
      `>=`) sui confronti `gap >= pauseThreshold` e sulla soglia
      `inspectionCut`/`solvedStartLikely`; quando due interpretazioni
      (numero di fasi, punto di taglio) sono vicine in punteggio, non
      scegliere la più aggressiva ma allargare la finestra di ispezione
      scelta all'unione delle candidate vicine.
    - `inferInspectionEnd`: quando la fonte del confine è `fallback` o
      `segmentation` (bassa confidenza) piuttosto che `state-change`,
      allargare `intervalEnd` con un margine di sicurezza esplicito
      invece di accettare il valore puntuale.

    **Criterio per l'adozione futura** (dichiarato dall'utente, da
    verificare quando/se la correzione sarà implementata): punteggio
    totale sopra 462/702, nessun video del gruppo test giù di più di 5
    caselle, finestra stabile sotto le stesse perturbazioni in almeno
    12/13 video — oggi, senza correzione, siamo a 3/13.

    Dati completi: `bench/results/window-sensitivity.json` (gitignored,
    locale — rigenerabile con lo strumento committato).

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
