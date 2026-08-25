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

## Strumenti di sviluppo

Per generare metadati e contact sheet da filmati locali:

```powershell
python -m pip install -r requirements-dev.txt
python tools/inspect_videos.py video.mov --output data/private/video-inspection
```
