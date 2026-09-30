import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertFrameIdAvailable, nextSafeIndex } from './extract-frames.ts';

test('nextSafeIndex riparte da 0 se il video non ha ancora fotogrammi', () => {
  assert.equal(nextSafeIndex([], 'IMG_9999'), 0);
  assert.equal(nextSafeIndex(['IMG_6107-000', 'IMG_6108-005'], 'IMG_9999'), 0);
});

test('nextSafeIndex continua dopo il massimo indice esistente per QUEL video', () => {
  const ids = ['IMG_6297-000', 'IMG_6297-024', 'IMG_6297-011', 'IMG_6298-030'];
  assert.equal(nextSafeIndex(ids, 'IMG_6297'), 25);
  assert.equal(nextSafeIndex(ids, 'IMG_6298'), 31);
});

test('assertFrameIdAvailable non lancia quando l\'id e\' libero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-frames-test-'));
  const frames = path.join(dir, 'frames');
  const labels = path.join(dir, 'labels');
  fs.mkdirSync(frames);
  fs.mkdirSync(labels);
  assert.doesNotThrow(() => assertFrameIdAvailable('IMG_9999-000', frames, labels));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assertFrameIdAvailable lancia se il fotogramma esiste gia\'', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-frames-test-'));
  const frames = path.join(dir, 'frames');
  const labels = path.join(dir, 'labels');
  fs.mkdirSync(frames);
  fs.mkdirSync(labels);
  fs.writeFileSync(path.join(frames, 'IMG_9999-000.jpg'), 'x');
  assert.throws(() => assertFrameIdAvailable('IMG_9999-000', frames, labels), /collisione/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assertFrameIdAvailable lancia se l\'etichetta esiste gia\' (anche senza il fotogramma)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-frames-test-'));
  const frames = path.join(dir, 'frames');
  const labels = path.join(dir, 'labels');
  fs.mkdirSync(frames);
  fs.mkdirSync(labels);
  fs.writeFileSync(path.join(labels, 'IMG_9999-000.json'), '{}');
  assert.throws(() => assertFrameIdAvailable('IMG_9999-000', frames, labels), /collisione/);
  fs.rmSync(dir, { recursive: true, force: true });
});
