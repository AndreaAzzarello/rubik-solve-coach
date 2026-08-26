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
- scegliere il colore della Cross;
- ottenere lo scramble inverso;
- avanzare nel replay mossa per mossa o riprodurlo automaticamente;
- osservare lo stato del cubo e le condizioni Cross, F2L, OLL e PLL;
- individuare rotazioni complete, wide move e slice move.

Il riconoscimento automatico del video viene collegato a questa interfaccia in
piu fasi. Il decoder temporale v3 e gia attivo: lavora localmente nel
browser, concentra l'analisi sull'area del cubo, individua picchi di movimento
anche ravvicinati e segnala quelli estesi, compatibili con wide move, rotazioni
o variazioni di presa. Il
nome della mossa resta da confermare finche non sara disponibile un modello
supervisionato affidabile.

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
