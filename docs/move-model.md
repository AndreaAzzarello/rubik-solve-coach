# Modello temporale delle mosse

## Sorgenti dati

Il primo benchmark riproducibile usa `cubed-core/cubed-data-v1`, pubblicato con
licenza CC-BY-SA-4.0. I 35 video vengono mantenuti fuori da Git in
`data/raw/cubed-data-v1`; ogni filmato e verificato usando dimensione e SHA-256
del manifest originale. L'attribuzione resta associata a ogni cattura.

I log BLE forniscono la mossa reale e un timestamp relativo. L'importatore
allinea automaticamente tale timeline al segnale di movimento del video e
registra offset, copertura e confidenza. Le divisioni train, validation e test
avvengono per cattura completa: fotogrammi della stessa solve non possono
comparire in due divisioni diverse.

## Regole di valutazione

- l'accuratezza esatta distingue faccia e verso (`R` da `R'`);
- l'accuratezza della faccia misura `R/L/U/D/F/B` senza il verso;
- il test resta formato da solve mai viste durante l'addestramento;
- le percentuali sul corpus indicano prestazioni sul singolo solver e sulla
  singola configurazione di ripresa, non generalizzazione universale;
- un modello entra nel sito soltanto se supera il decoder euristico sul test e
  conserva un meccanismo di astensione per i casi incerti.

I video YouTube servono a catalogare varianti di fingertrick, ma non vengono
copiati nel dataset di addestramento senza una licenza e una timeline verificata.

## Riproduzione locale

Con Python 3.12 e una GPU NVIDIA recente:

```powershell
python -m pip install -r requirements-ml.txt
python -m tools.import_cubed_dataset --download full
python -m tools.train_temporal_move_model --rebuild-features
```

L'importatore preferisce la timeline esatta per fotogramma quando il corpus la
fornisce; negli altri casi stima l'offset confrontando tutti i picchi di movimento
con il log BLE. Il modello distingue i 12 quarti di giro (`R`, `R'` e gli
equivalenti sulle altre cinque facce). Il log BLE registra `R2` come due impulsi
`R`: il livello temporale li ricompone in una doppia mossa. Rotazioni, slice e
wide move restano nel classificatore geometrico mani+cubo perché il log BLE non
le etichetta.

Il file destinato al browser viene generato soltanto se il test per cattura
separata raggiunge almeno il 45% di accuratezza esatta e il 65% sulla faccia.
