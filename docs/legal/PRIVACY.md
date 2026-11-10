# Informativa sulla privacy — CubeSolve Coach

> **BOZZA, non pubblicare.** I segnaposto `[[DA COMPLETARE]]` richiedono i dati
> del titolare: non vanno inventati. L'accessibilità del testo pubblicato si
> cura con il redesign.

## In breve
Il video che scegli viene analizzato **solo nel tuo browser**. Non viene caricato
su alcun server, non viene condiviso e non viene salvato. L'app non usa cookie
né strumenti di analisi o pubblicità.

## Titolare del trattamento
[[DA COMPLETARE: nome o ragione sociale del titolare]]
Contatto: [[DA COMPLETARE: indirizzo email o PEC di contatto]]

## Che cosa succede al tuo video
- Il file resta sul tuo dispositivo: viene letto in memoria dal browser (come
  `blob:` locale) e analizzato lì, fotogramma per fotogramma.
- Non c'è un backend: nessun upload, nessuna richiesta di rete con il contenuto
  del video o dei fotogrammi.
- Chiudendo o ricaricando la pagina, il video e i risultati dell'analisi
  vengono dimenticati.

## Cookie, analytics, archiviazione locale
- **Cookie:** nessuno. **Analytics, pubblicità, tracciamento:** nessuno.
- **`localStorage`, `sessionStorage`, IndexedDB:** non usati.
- **Cache del browser (Cache Storage, tramite service worker):** l'app salva
  nel browser i propri file per funzionare anche offline e caricarsi più in
  fretta. Sono solo file dell'app, non contengono dati personali e puoi
  cancellarli dalle impostazioni del browser:
  - alla prima visita: la pagina iniziale, `manifest.json` e l'icona
    `favicon.svg`;
  - man mano che servono: gli script e gli stili dell'app, il modello di
    riconoscimento del cubo (`/models/cube-face-keypoints.onnx`) e il runtime
    WebAssembly di ONNX;
  - quando viene usato il riconoscimento delle mani: i file di MediaPipe
    (`/mediapipe/hand_landmarker.task` e `/mediapipe/wasm/`, circa 12 MB in
    tutto), che restano in cache senza essere riscaricati finché l'app non
    li aggiorna.
  Il video e i fotogrammi non vengono mai salvati in cache. Il service worker
  non salva risposte di altri siti.

## Risorse esterne e telemetria di MediaPipe
A runtime l'app non richiede file a domini di terzi: tutto viene servito dallo
stesso sito. Nessun font, script, mappa o contenuto incorporato da terzi.

La libreria MediaPipe (di Google), usata per riconoscere le mani, tenta per
conto suo di inviare a Google (`odml.pa.googleapis.com`) un log tecnico d'uso.
Secondo l'analisi della richiesta (circa 136 byte) contiene la versione della
libreria e dati numerici di funzionamento; nessun fotogramma e nessun video.
L'app **blocca** questa richiesta con una Content Security Policy
(`connect-src 'self' blob: data:`) che consente al browser di contattare solo
il sito stesso: nei browser che applicano la CSP la richiesta non parte.
Nei browser che non la applicano la richiesta può partire e, in quel caso,
Google riceverebbe il tuo indirizzo IP, lo user agent e la pagina di
provenienza. Nessun dato del video lascia il dispositivo.
[[DA COMPLETARE: formulazione finale da concordare con il titolare]]

## Hosting e dati tecnici di connessione
Come per ogni sito web, il fornitore di hosting riceve i dati tecnici
necessari a inviarti le pagine (per esempio indirizzo IP e user agent) e può
registrarli nei propri log.
- Fornitore di hosting: [[DA COMPLETARE: fornitore e sede, da confermare con
  il deploy reale]]
- Base giuridica: [[DA COMPLETARE: da definire con il titolare]]
- Tempo di conservazione dei log: [[DA COMPLETARE: dal fornitore]]

## I tuoi diritti
Hai diritto di accesso, rettifica, cancellazione, limitazione, portabilità e
opposizione (artt. 15-22 GDPR) e di proporre reclamo al Garante per la
protezione dei dati personali. Per esercitarli: [[DA COMPLETARE: contatto]].

## Aggiornamenti
Ultima revisione: [[DA COMPLETARE: data]]
