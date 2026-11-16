/**
 * Unit tests for src/backdrop-store.js — the migration and scope rules the
 * browser bundle depends on, exercised in Node with a Map-backed storage stub.
 *
 *   node tools/test-store.mjs
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_SCOPE,
  STORAGE_VERSION,
  createBackdropStore,
  mergeConfig,
  normalizeStore,
  sanitizeConfig,
} from '../src/backdrop-store.js';

const DEFAULTS = {
  opacity: 0.62,
  imageUrl: '',
  imageName: '',
  imageDim: 0,
  imageSize: 'cover',
  imagePosition: 'center',
  bubbleKeep: 0.78,
  cardKeep: 0.84,
  cardBlur: 14,
  embedded: false,
};

function memory(initial) {
  const map = new Map();
  if (initial !== undefined) map.set('k', initial);
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
    dump: () => map.get('k'),
  };
}

const make = (storage) => createBackdropStore({ storage, key: 'k', defaults: DEFAULTS });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── migration ───────────────────────────────────────────────────────────────

test('v1 flat config migrates into the default scope', () => {
  const v1 = {
    opacity: 0.14,
    imageUrl: 'data:image/webp;base64,AAAA',
    imageName: '云虫-月牙-凝视地球仪.jpg',
    imageDim: 0,
    imageSize: 'cover',
    imagePosition: 'center',
    bubbleKeep: 0.78,
    cardKeep: 0.84,
    cardBlur: 14,
    embedded: false,
  };
  const store = make(memory(JSON.stringify(v1)));
  const effective = store.effectiveFor(DEFAULT_SCOPE);
  assert.equal(effective.opacity, 0.14);
  assert.equal(effective.imageUrl, v1.imageUrl);
  assert.equal(effective.imageName, v1.imageName);
  assert.equal(store.list().length, 0, 'migration must not invent workspace overrides');
  // A workspace without an override inherits the migrated default.
  assert.deepEqual(store.effectiveFor('ws-1'), effective);
});

test('v1 garbage keys are dropped, not carried into the default', () => {
  const store = make(memory(JSON.stringify({ opacity: 0.4, evil: 'x', __proto__: { hacked: true } })));
  const effective = store.effectiveFor(DEFAULT_SCOPE);
  assert.equal(effective.opacity, 0.4);
  assert.equal('evil' in effective, false);
  assert.equal('hacked' in effective, false);
});

test('missing storage yields factory defaults', () => {
  const store = make(memory(undefined));
  assert.deepEqual(store.effectiveFor(DEFAULT_SCOPE), DEFAULTS);
});

// ── scopes ──────────────────────────────────────────────────────────────────

test('a workspace override only replaces the fields it sets', () => {
  const store = make(memory(JSON.stringify({
    v: STORAGE_VERSION,
    default: { opacity: 0.5, imageUrl: 'data:image/webp;base64,DEFAULT' },
    workspaces: {},
  })));
  store.write('ws-a', { opacity: 0.9 });
  const effective = store.effectiveFor('ws-a');
  assert.equal(effective.opacity, 0.9);
  assert.equal(effective.imageUrl, 'data:image/webp;base64,DEFAULT', 'image must be inherited');
  assert.equal(store.hasOverride('ws-a'), true);
  assert.equal(store.owns('ws-a', 'opacity'), true);
  assert.equal(store.owns('ws-a', 'imageUrl'), false);
  assert.deepEqual(store.effectiveFor('ws-b'), store.effectiveFor(DEFAULT_SCOPE));
});

test('writing undefined deletes the field, and an empty override disappears', () => {
  const store = make(memory(undefined));
  store.write('ws-a', { opacity: 0.3 });
  store.write('ws-a', { opacity: undefined });
  assert.equal(store.hasOverride('ws-a'), false);
  assert.deepEqual(store.list(), []);
  assert.equal(store.effectiveFor('ws-a').opacity, DEFAULTS.opacity);
});

test('an override can pin the built-in picture over a custom default', () => {
  const store = make(memory(undefined));
  store.write(DEFAULT_SCOPE, { imageUrl: 'data:image/webp;base64,CUSTOM' });
  store.write('ws-a', { imageUrl: '' });
  assert.equal(store.effectiveFor('ws-a').imageUrl, '');
  assert.equal(store.effectiveFor(DEFAULT_SCOPE).imageUrl, 'data:image/webp;base64,CUSTOM');
});

test('clear drops one workspace override', () => {
  const store = make(memory(undefined));
  store.write('ws-a', { opacity: 0.8 });
  store.write('ws-b', { opacity: 0.7 });
  store.clear('ws-a');
  assert.deepEqual(store.list(), ['ws-b']);
  assert.equal(store.effectiveFor('ws-a').opacity, DEFAULTS.opacity);
});

test('reset returns everything to factory defaults', () => {
  const store = make(memory(undefined));
  store.write(DEFAULT_SCOPE, { opacity: 0.2 });
  store.write('ws-a', { opacity: 0.8 });
  store.reset();
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.effectiveFor('ws-a'), DEFAULTS);
});

// ── validation and safety ───────────────────────────────────────────────────

test('sanitize drops unknown keys and wrong value types', () => {
  const clean = sanitizeConfig(
    { opacity: 'high', cardBlur: 8, embedded: 'yes', nope: 1, imageName: 42 },
    DEFAULTS,
  );
  assert.deepEqual(clean, { cardBlur: 8 });
});

test('normalize ignores prototype-polluting workspace ids', () => {
  const payload = {
    v: STORAGE_VERSION,
    default: {},
    workspaces: {
      __proto__: { opacity: 0.1 },
      constructor: { opacity: 0.2 },
      'ws-ok': { opacity: 0.3 },
    },
  };
  const store = normalizeStore(payload, DEFAULTS);
  assert.deepEqual(Object.keys(store.workspaces), ['ws-ok']);
  assert.equal({}.opacity, undefined, 'Object.prototype must stay clean');
});

test('write refuses unsafe scope ids', () => {
  const store = make(memory(undefined));
  store.write('__proto__', { opacity: 0.05 });
  assert.deepEqual(store.list(), []);
  assert.equal(store.effectiveFor(DEFAULT_SCOPE).opacity, DEFAULTS.opacity);
});

// ── persistence ─────────────────────────────────────────────────────────────

test('persist round-trips through storage and reloads', () => {
  const storage = memory(undefined);
  const store = make(storage);
  store.write(DEFAULT_SCOPE, { opacity: 0.42, imageUrl: 'data:image/webp;base64,AAA' });
  store.write('ws-a', { opacity: 0.7 });
  assert.equal(store.persist(), true);
  const reloaded = make(storage);
  assert.equal(reloaded.effectiveFor(DEFAULT_SCOPE).opacity, 0.42);
  assert.equal(reloaded.effectiveFor('ws-a').opacity, 0.7);
  assert.equal(reloaded.effectiveFor('ws-a').imageUrl, 'data:image/webp;base64,AAA');
  assert.equal(JSON.parse(storage.dump()).v, STORAGE_VERSION);
});

test('a failing storage reports false instead of throwing', () => {
  const failing = {
    getItem: () => null,
    setItem: () => { throw new Error('quota'); },
  };
  const store = make(failing);
  store.write(DEFAULT_SCOPE, { opacity: 0.3 });
  assert.equal(store.persist(), false);
  assert.equal(store.effectiveFor(DEFAULT_SCOPE).opacity, 0.3, 'the change still applies in memory');
});

// ── notifications ──────────────────────────────────────────────────────────

test('every mutation notifies subscribers exactly once', () => {
  const store = make(memory(undefined));
  let count = 0;
  const off = store.subscribe(() => { count += 1; });
  store.write('ws-a', { opacity: 0.1 });
  store.clear('ws-a');
  store.reset();
  off();
  store.write('ws-b', { opacity: 0.2 });
  assert.equal(count, 3);
});

test('mergeConfig ignores unknown keys and non-object layers', () => {
  const merged = mergeConfig(DEFAULTS, { opacity: 0.5, unknown: true }, null, { cardBlur: 0 });
  assert.equal(merged.opacity, 0.5);
  assert.equal(merged.cardBlur, 0);
  assert.equal('unknown' in merged, false);
});

// ── runner ─────────────────────────────────────────────────────────────────

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
