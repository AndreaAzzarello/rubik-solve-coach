import assert from 'node:assert/strict';
import test from 'node:test';
import { CONNECT_ONLY_CSP } from './csp.ts';

test('la CSP limita solo connect-src a origine propria, blob e data', () => {
  assert.equal(CONNECT_ONLY_CSP, "connect-src 'self' blob: data:");
});

test('la CSP non contiene altre direttive ne origini di terzi', () => {
  const directives = CONNECT_ONLY_CSP.split(';').map((part) => part.trim()).filter(Boolean);
  assert.equal(directives.length, 1);
  assert.doesNotMatch(CONNECT_ONLY_CSP, /https?:|\*/);
  assert.doesNotMatch(CONNECT_ONLY_CSP, /script-src|default-src|worker-src/);
});
