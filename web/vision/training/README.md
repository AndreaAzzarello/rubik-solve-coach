# Training · rilevatore vertici faccia cubo

Step 3 del piano: alleniamo YOLOv8n-pose (una classe `cube_face`, 4 keypoint)
sul dataset sintetico generato da `vision/dataset/generate-dataset.ts`, su
Colab (niente GPU locale).

## Come usarlo

1. Apri `train_colab.ipynb` in Google Colab (upload diretto, o via Drive/GitHub).
2. `Runtime > Cambia tipo di runtime > GPU`.
3. Dataset: nella cella dei parametri, `DATASET_SOURCE = 'drive_zip'` (default,
   consigliata) carica `vision/dataset/cube-face-keypoints-dataset.zip`
   (generato in locale con `node --experimental-strip-types vision/dataset/generate-dataset.ts`)
   da `MyDrive/rubik-vision/` su Google Drive. `DATASET_SOURCE =
   'regenerate_in_colab'` rigenera il dataset direttamente in Colab (richiede
   il branch pushato su GitHub) — piu' lento, utile solo per variare/ampliare
   i dati senza ricaricare uno zip. La cella successiva esegue SOLO il ramo
   scelto (l'altro si auto-salta) e si ferma con un errore chiaro se un
   passaggio fallisce, quindi "Esegui tutte le celle" e' sicuro.
4. Esegui le celle di training + validazione + export ONNX in ordine.
5. Copia il `.onnx` risultato in `vision/models/cube-face-keypoints.onnx` nel
   repo (cartella creata al bisogno, non ancora presente).

## Ricreare lo zip (se rigeneri il dataset in locale)

**Non usare `Compress-Archive` di PowerShell**: scrive i percorsi nello zip
con backslash (`images\train\...`), che gli strumenti Linux (compreso il
modulo `zipfile` di Python usato dal notebook) trattano come un nome di file
letterale invece che come sottocartella — l'estrazione in Colab produce file
piatti con backslash nel nome invece di `images/train/...`, e il training
fallisce con "images not found" anche se lo zip sembra valido. Usa invece:

```
python -c "
import os, zipfile
src, dest = 'output', 'cube-face-keypoints-dataset.zip'
with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(src):
        for name in files:
            full = os.path.join(root, name)
            zf.write(full, os.path.relpath(full, src).replace(os.sep, '/'))
"
```

(da dentro `vision/dataset/`, con `output/` gia' generato) — scrive sempre
`/` indipendentemente dal sistema operativo.

## Perche' Ultralytics YOLOv8n-pose

Discusso nel piano: gestisce nativamente un numero variabile di istanze per
immagine (1-3 facce visibili), esport ONNX diretto, "nano" abbastanza piccolo
per l'inferenza CPU/WASM nel browser. Licenza AGPL-3.0 accettata per una repo
pubblica; solo pesi + codice di inferenza nostro finiscono nel prodotto, non
il codice di training Ultralytics.

## flip_idx e ordine dei keypoint

`data.yaml` (generato insieme al dataset) include `flip_idx: [0, 3, 2, 1]`:
i 4 keypoint sono ordinati geometricamente (dal piu' in alto, in senso
angolare) non semanticamente (nessuna nozione di "quale faccia/lato" — quella
disambiguazione resta a valle, vedi `vision/dataset/annotation.ts`). Sotto
flip orizzontale l'indice 0 resta fisso (la coordinata Y non cambia) e gli
altri tre si invertono. Senza questa riga l'augmentation flip di Ultralytics
corromperebbe silenziosamente le etichette.

## Non ancora fatto

- Metrica del piano (PCK, grid-cell hit-rate sul val set sintetico) — il
  notebook riporta solo le metriche pose native di Ultralytics (mAP/OKS).
- Verifica di trasferimento su foto reali.
- Integrazione nel browser (`onnxruntime-web`, backend wasm).
