// Step 3 del piano: fonde i fotogrammi annotati a mano (vision/annotate) nel
// dataset sintetico gia' generato (vision/dataset/output), cosi' lo zip che
// va in Colab (vedi training/README.md) contiene entrambi.
//
// Copia solo i fotogrammi annotati con almeno una faccia e non scartati
// (quelli con un .txt in annotate/labels/): lo split train/val e' quello
// deciso in fase di estrazione (annotate/frames/manifest.json), non
// rigenerato qui, per restare coerente con l'annotazione fatta a mano.
//
//   node --experimental-strip-types vision/dataset/merge-real-annotations.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANNOTATE_DIR = path.join(HERE, '..', 'annotate');
const FRAMES_DIR = path.join(ANNOTATE_DIR, 'frames');
const LABELS_DIR = path.join(ANNOTATE_DIR, 'labels');
const OUT_DIR = path.join(HERE, 'output');

type ManifestEntry = { id: string; video: string; time: number; split: 'train' | 'val' };

function main() {
  const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(path.join(FRAMES_DIR, 'manifest.json'), 'utf8'));
  const splitById = new Map(manifest.map((entry) => [entry.id, entry.split]));

  const labelFiles = fs.readdirSync(LABELS_DIR).filter((f) => f.endsWith('.txt'));

  let copied = 0;
  const perSplit = { train: 0, val: 0 };

  for (const labelFile of labelFiles) {
    const id = labelFile.replace(/\.txt$/, '');
    const split = splitById.get(id);
    if (!split) {
      console.warn(`salto ${id}: non presente in manifest.json`);
      continue;
    }

    const srcImage = path.join(FRAMES_DIR, `${id}.jpg`);
    const srcLabel = path.join(LABELS_DIR, labelFile);
    if (!fs.existsSync(srcImage)) {
      console.warn(`salto ${id}: fotogramma mancante (${srcImage})`);
      continue;
    }

    const imagesDir = path.join(OUT_DIR, 'images', split);
    const labelsDir = path.join(OUT_DIR, 'labels', split);
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.mkdirSync(labelsDir, { recursive: true });

    // Prefisso "real-" per non collidere mai con i nomi sintetici
    // (train-000000 ecc.) e per poter distinguere a colpo d'occhio le due
    // fonti dentro output/.
    const name = `real-${id}`;
    fs.copyFileSync(srcImage, path.join(imagesDir, `${name}.jpg`));
    fs.copyFileSync(srcLabel, path.join(labelsDir, `${name}.txt`));
    copied += 1;
    perSplit[split] += 1;
  }

  console.log(`copiati ${copied} fotogrammi reali in ${OUT_DIR} (train: ${perSplit.train}, val: ${perSplit.val})`);
}

main();
