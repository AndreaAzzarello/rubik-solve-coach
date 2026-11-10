import assert from 'node:assert/strict';
import test from 'node:test';
import { SOURCE_CODE_LABEL, SOURCE_CODE_URL } from './legal.ts';

// AGPL-3.0, par. 13: chi usa l'app in rete deve poter raggiungere il sorgente.
test('il link al sorgente punta al repository pubblico via https', () => {
  const url = new URL(SOURCE_CODE_URL);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'github.com');
  assert.equal(url.pathname, '/AndreaAzzarello/rubik-solve-coach');
});

test('l etichetta del link e testuale e cita la licenza', () => {
  assert.equal(SOURCE_CODE_LABEL, 'Codice sorgente (AGPL-3.0)');
});
