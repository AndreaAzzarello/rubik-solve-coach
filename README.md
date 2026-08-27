# CubeSolve Coach

Applicazione mobile per analizzare una risoluzione del cubo di Rubik 3x3 da un
video, ricostruire le mosse eseguite e trasformare la registrazione in un'analisi
tecnica personalizzata.

## Obiettivo

L'app dovra:

- trascrivere le mosse con il relativo timestamp;
- riconoscere rotazioni, wide move e slice move;
- suddividere una solve CFOP in Cross, F2L, OLL e PLL;
- riprodurre la sequenza su un cubo virtuale;
- evidenziare pause, rotazioni ed eventuali passaggi inefficienti;
- suggerire alternative considerando ergonomia, lookahead e algoritmi conosciuti;
- rispettare la preferenza dell'utente per il colore della Cross;
- ricostruire uno scramble valido per lo stato iniziale.

## Prima versione

Il primo MVP sara limitato a:

- cubo 3x3;
- video guidati, senza tagli e con camera fissa;
- analisi del metodo CFOP;
- configurazione della Cross preferita;
- revisione manuale dei passaggi riconosciuti con bassa affidabilita;
- cubo virtuale per verificare la sequenza estratta.

Il supporto per video liberi, Roux, ZB e altri metodi verra valutato nelle fasi
successive.

## Video di test

I filmati personali e gli output di ispezione restano locali e non vengono
caricati su GitHub. Nel repository vengono salvati soltanto gli strumenti di
analisi e i metadati non sensibili descritti in
[`docs/test-videos.md`](docs/test-videos.md).

## Stato del progetto

Il progetto contiene ora un primo motore matematico di riferimento. Gestisce la
notazione, lo stato dei 54 sticker, le fasi CFOP, la Cross preferita e la
ricostruzione dello scramble. I dettagli si trovano in
[`docs/core-engine.md`](docs/core-engine.md).

La specifica funzionale completa si trova in
[`docs/product-scope.md`](docs/product-scope.md).

Per eseguire i test del motore:

```powershell
python -m unittest discover -s tests -v
```

Per analizzare una sequenza gia trascritta:

```powershell
python -m tools.analyze_algorithm --solution "R U R' U'" --cross-color yellow
```

## MVP web

La cartella [`web`](web/) contiene un sito interattivo per provare il motore nel
browser. La prima versione permette di:

- inserire e validare una sequenza di mosse;
- dedurre il colore della Cross dalla progressione della solve;
- ottenere lo scramble inverso;
- avanzare nel replay mossa per mossa o riprodurlo automaticamente;
- osservare lo stato del cubo e le condizioni Cross, F2L, OLL e PLL;
- individuare rotazioni complete, wide move e slice move.

Il riconoscimento automatico del video viene collegato a questa interfaccia in
piu fasi. Il decoder video v9 e attivo e fonde due canali locali:

- variazione di luminosita e colore nell'area del cubo;
- traiettoria di 21 landmark per mano, distinguendo movimento del palmo e
  movimento residuo delle dita.

Una breve finestra temporale collega il fingertrick che inizia prima al
cambiamento degli sticker che segue. Se il cubo e coperto puo sostenere il
pacchetto il canale mani; se le mani escono dal campo resta disponibile il
canale cubo. I picchi distanti al massimo circa 0,62 secondi vengono conservati
nella stessa finestra, fino a 1,35 secondi: una fingertrick veloce puo quindi
produrre un pacchetto di piu mosse invece di essere forzata in eventi singoli.
Ogni pacchetto espone la sorgente dell'evidenza, il numero di mosse interne, la
sequenza proposta e la relativa clip completa a `0,40x`.

La rianalisi sposta leggermente istanti di campionamento e area osservata,
allinea le finestre temporali sovrapposte e aumenta l'affidabilita soltanto dei
pacchetti ritrovati. Se la prima lettura resta sotto
l'82%, il browser avvia automaticamente fino a tre letture; il pulsante di
rianalisi aggiunge poi altre letture alla stessa sovrapposizione. Dopo due
letture concordi la soglia di accettazione scende all'84%. L'interfaccia mostra
la confidenza media e il numero di letture confrontate; revisione,
segmentazione e dati tecnici restano disponibili in pannelli richiudibili. Il
video non viene caricato: il browser scarica il modello MediaPipe e svolge
l'inferenza sul dispositivo.

Il v7 separa esplicitamente l'intervallo di osservazione/preparazione dalla
solve. Nei fotogrammi stabili precedenti alla partenza censisce i sei colori e
mostra quanto materiale utile ha realmente osservato; le rotazioni di
preparazione restano fuori dalla sequenza della solve. Per ogni pacchetto della
solve propone una sequenza modificabile combinando tutti i picchi interni,
posizione spaziale del cambiamento, traiettoria delle dita e variazione del
cubo. I pacchetti vengono concatenati nel campo finale senza `?`: replay,
scramble inverso e divisione Cross/F2L/OLL/PLL appaiono al termine dell'analisi
e si aggiornano quando viene corretta una finestra.

Negli ultimi fotogrammi stabili della solve il decoder cerca inoltre il colore
dominante della faccia PLL. Quando la lettura supera la soglia minima, la Cross
viene proposta usando la coppia di colori opposti (`bianco-giallo`,
`arancio-rosso`, `verde-blu`). L'interfaccia mostra sia il colore PLL osservato
sia la Cross risultante; se l'immagine e ambigua resta attiva la deduzione dalla
progressione della sequenza, senza forzare l'indizio cromatico.

Il v8 ricompone inoltre due quarti di giro consecutivi uguali nella notazione
doppia (`R R` o `R' R'` diventano `R2`) prima di creare i pacchetti finali.

Il v9 usa invece l'intero intervallo precedente alla partenza come scansione
dello stato iniziale. Cerca griglie 3x3 nei fotogrammi stabili, allinea e fonde
piu viste della stessa faccia e riporta separatamente facce, caselle, angoli e
spigoli risolti. Le caselle coperte vengono inferite solo quando unicita dei
pezzi, somma degli orientamenti e parita delle permutazioni lasciano un unico
stato legale. Soltanto in quel caso il sito calcola uno scramble nella
convenzione bianco sopra e verde davanti e lo verifica riproducendo lo stato
casella per casella. Una lettura parziale resta esplicitamente ambigua. Dettagli
e fonti sono in [`docs/inspection-reconstruction.md`](docs/inspection-reconstruction.md).

Per verificare il ricostruttore TypeScript:

```powershell
pnpm --dir web test:inspection
```

## Benchmark supervisionato

Gli strumenti in [`tools/import_cubed_dataset.py`](tools/import_cubed_dataset.py)
e [`tools/train_temporal_move_model.py`](tools/train_temporal_move_model.py)
scaricano, verificano e allineano il corpus pubblico `cubed-data-v1`, quindi
addestrano sulla GPU un classificatore temporale browser-compatibile. Le solve
sono divise per cattura completa per impedire che fotogrammi dello stesso video
entrino sia nel training sia nel test.

Il primo modello v2 ha ottenuto 19,92% esatto e 29,08% sulla faccia in 502 mosse
provenienti da cinque solve mai viste. Non supera la soglia di pubblicazione
(45% esatto e 65% faccia), quindi i suoi pesi non vengono copiati nel sito e non
possono abbassare la qualita del decoder attivo. Il report completo e i video
restano locali e ignorati da Git. La procedura riproducibile e descritta in
[`docs/move-model.md`](docs/move-model.md).

La UI mantiene separate due affidabilita: esistenza del movimento e identita
della notazione. Una proposta automatica non viene presentata come verificata:
lo scramble e marcato come stima finche tutte le mosse non sono state
controllate. La scansione dei colori misura la copertura osservata, ma non
dichiara ricostruito uno stato sticker-per-sticker quando il filmato non offre
ancora abbastanza viste stabili.

Per i video con una sola risoluzione non e necessario marcare manualmente
l'inizio o la fine: il decoder segmenta la registrazione in blocchi compatibili
con scramble, ispezione e solve e seleziona l'ultimo blocco come proposta. Nei
video con piu tentativi l'utente puo scegliere un altro blocco oppure limitare
manualmente l'intervallo. Sui filmati lunghi la soglia viene limitata rispetto
alla distribuzione reale del movimento, evitando che scramble e solve vengano
scambiati per rumore di fondo.

## Strumenti di sviluppo

Per generare metadati e contact sheet da filmati locali:

```powershell
python -m pip install -r requirements-dev.txt
python tools/inspect_videos.py video.mov --output data/private/video-inspection
python tools/calibrate_motion_decoder.py video.mov --output data/private/motion-calibration.json
```
