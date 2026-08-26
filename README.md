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
piu fasi. Il decoder temporale v4 e gia attivo e fonde due canali locali:

- variazione di luminosita e colore nell'area del cubo;
- traiettoria di 21 landmark per mano, distinguendo movimento del palmo e
  movimento residuo delle dita.

Una breve finestra temporale collega il fingertrick che inizia prima al
cambiamento degli sticker che segue. Se il cubo e coperto puo sostenere
l'evento il canale mani; se le mani escono dal campo resta disponibile il
canale cubo. L'interfaccia espone per ogni evento la sorgente dell'evidenza e
la forza dei due segnali. Durante la verifica, ogni evento apre una breve clip
rallentata con margine prima e dopo il picco; la riproduzione si ferma
automaticamente alla fine della finestra, cosi il movimento da confermare resta
isolato. Il video non viene caricato: il browser scarica il modello MediaPipe e
svolge l'inferenza sul dispositivo.

Il nome della mossa resta da confermare finche non sara disponibile un modello
supervisionato affidabile per `U/R/F/...`; la traiettoria della mano da sola non
dimostra quale faccia sia stata ruotata quando orientamento o sticker sono
ambigui.

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
