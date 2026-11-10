import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MEDIAPIPE_REQUIRED_FILES,
  MEDIAPIPE_TASK_SHA256,
  classifyMediapipeRequest,
  isMediapipeCdn,
  mediapipeIntegrityIssues,
} from './mediapipe-local.ts';

function tempMediapipeDir(taskBytes: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediapipe-test-'));
  for (const rel of MEDIAPIPE_REQUIRED_FILES) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, rel.endsWith('.task') ? taskBytes : 'x');
  }
  return dir;
}

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

test('i file in public/mediapipe sono completi e il .task ha l hash fissato', () => {
  assert.deepEqual(mediapipeIntegrityIssues(), []);
});

test('il .task con un hash diverso viene segnalato', () => {
  const dir = tempMediapipeDir('modello cambiato');
  try {
    const issues = mediapipeIntegrityIssues(dir, sha('modello atteso'));
    assert.equal(issues.length, 1);
    assert.match(issues[0], /SHA-256/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('un file mancante viene segnalato per nome', () => {
  const dir = tempMediapipeDir('ok');
  try {
    fs.rmSync(path.join(dir, 'wasm', 'vision_wasm_internal.wasm'));
    const issues = mediapipeIntegrityIssues(dir, sha('ok'));
    assert.ok(issues.some((issue) => issue.includes('vision_wasm_internal.wasm')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('l hash atteso e quello del README (modello float16 rev. 1)', () => {
  assert.equal(MEDIAPIPE_TASK_SHA256, 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1');
});

test('classifica le richieste MediaPipe e riconosce i CDN esterni', () => {
  assert.equal(classifyMediapipeRequest('http://localhost:3100/mediapipe/hand_landmarker.task'), 'model');
  assert.equal(classifyMediapipeRequest('http://localhost:3100/mediapipe/wasm/vision_wasm_internal.wasm'), 'wasm');
  assert.equal(classifyMediapipeRequest('http://localhost:3100/mediapipe/wasm/vision_wasm_internal.js'), 'wasm');
  assert.equal(classifyMediapipeRequest('http://localhost:3100/models/cube-face-keypoints.onnx'), 'other');
  assert.equal(isMediapipeCdn('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/x.wasm'), true);
  assert.equal(isMediapipeCdn('https://storage.googleapis.com/mediapipe-models/x.task'), true);
  assert.equal(isMediapipeCdn('http://localhost:3100/mediapipe/hand_landmarker.task'), false);
});
