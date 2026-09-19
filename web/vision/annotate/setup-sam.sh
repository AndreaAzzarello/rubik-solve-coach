#!/bin/sh
# Scarica UNA VOLTA i pesi ONNX di MobileSAM (encoder + decoder a piena
# precisione) nella cache locale di vision/annotate (gitignored), usati per
# pre-annotare i fotogrammi reali con una maschera invece di 4 punti a caso.
#
# Fonte: repo MIT akbartus/MobileSAM-in-the-Browser (decoder committato li',
# encoder ospitato separatamente su Hugging Face - stesso autore/progetto).
# Dimensioni verificate: encoder 28.195.125 byte, decoder 16.514.086 byte.
#
# NON il decoder "quant" (quantizzato, ~9MB, stesso repo): verificato che
# segmenta spesso un singolo sticker invece dell'intera faccia (score alto in
# entrambi i casi, quindi il sintomo non si vede dal punteggio) - il decoder a
# piena precisione, a parita' di tutto il resto, non ha questo problema.

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$HERE/.cache/mobilesam"
mkdir -p "$CACHE_DIR"

if [ ! -f "$CACHE_DIR/encoder.onnx" ]; then
  echo "[setup-sam] scarico l'encoder (~28MB)..."
  curl -sL --fail "https://huggingface.co/spaces/Akbartus/projects/resolve/main/mobilesam.encoder.onnx" -o "$CACHE_DIR/encoder.onnx"
else
  echo "[setup-sam] encoder gia' presente"
fi

if [ ! -f "$CACHE_DIR/decoder.onnx" ]; then
  echo "[setup-sam] scarico il decoder a piena precisione (~16.5MB)..."
  curl -sL --fail "https://raw.githubusercontent.com/akbartus/MobileSAM-in-the-Browser/main/models/mobilesam.decoder.onnx" -o "$CACHE_DIR/decoder.onnx"
else
  echo "[setup-sam] decoder gia' presente"
fi

echo "[setup-sam] pronto: $CACHE_DIR"
