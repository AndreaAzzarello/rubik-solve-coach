import assert from 'node:assert/strict';
import test from 'node:test';
import { assetUrl } from './asset-url.ts';

test('senza base path il percorso parte dalla radice', () => {
  assert.equal(assetUrl('mediapipe/wasm', ''), '/mediapipe/wasm');
  assert.equal(assetUrl('/mediapipe/hand_landmarker.task', ''), '/mediapipe/hand_landmarker.task');
});

test('con un base path lo antepone senza doppie barre', () => {
  assert.equal(assetUrl('mediapipe/wasm', '/sub'), '/sub/mediapipe/wasm');
  assert.equal(assetUrl('/mediapipe/wasm', '/sub/'), '/sub/mediapipe/wasm');
});

test('il default legge il base path iniettato da vinext (__NEXT_ROUTER_BASEPATH)', () => {
  const previous = process.env.__NEXT_ROUTER_BASEPATH;
  try {
    delete process.env.__NEXT_ROUTER_BASEPATH;
    assert.equal(assetUrl('mediapipe/x'), '/mediapipe/x');
    process.env.__NEXT_ROUTER_BASEPATH = '/sub';
    assert.equal(assetUrl('mediapipe/x'), '/sub/mediapipe/x');
  } finally {
    if (previous === undefined) delete process.env.__NEXT_ROUTER_BASEPATH;
    else process.env.__NEXT_ROUTER_BASEPATH = previous;
  }
});
