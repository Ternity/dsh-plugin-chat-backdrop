/**
 * Offline boot check for dist/client.js.
 *
 *   node tools/test-bundle.mjs [path/to/dist/client.js]
 *
 * The web shell executes a plugin bundle as a classic script and the client
 * module system then materializes its factory. Either step throwing leaves the
 * entry without a fiber, which DSH 0.2.2's boot audit treats as fatal for the
 * whole page, so this file replays exactly those two steps in a stub realm:
 *
 *   1. evaluate the bundle and require it to register one module via
 *      window.__ModuleLoader__.load({ id, factory }) under its own package name;
 *   2. materialize the factory with the platform seed table it may require and
 *      require it to hand back an activatable plugin ({ apply, inject }).
 *
 * It is deliberately dependency-free: the shape it checks is the shape the real
 * shell needs, and CI runs it next to the store tests.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = process.argv[2] ?? join(root, 'dist', 'client.js');
const packageName = 'dsh-plugin-chat-backdrop';

const source = readFileSync(bundlePath, 'utf8');
assert.ok(source.length > 0, 'bundle is empty');

const registrations = [];
const noop = () => {};
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  queueMicrotask,
  requestAnimationFrame: (fn) => setTimeout(fn, 16),
  cancelAnimationFrame: clearTimeout,
  location: { href: 'dsh-app://app/', origin: 'dsh-app://app' },
  navigator: { language: 'zh-CN', userAgent: 'node' },
  document: {
    documentElement: { lang: 'zh-CN', dataset: {}, style: { setProperty: noop, removeProperty: noop } },
    body: { hasAttribute: () => false, setAttribute: noop, removeAttribute: noop, dataset: {} },
    head: { append: noop },
    createElement: () => ({
      style: {}, dataset: {}, append: noop, remove: noop, setAttribute: noop,
      classList: { add: noop, remove: noop },
    }),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: noop,
    removeEventListener: noop,
  },
  window: {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration);
      },
    },
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  performance: { now: () => Date.now() },
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox.window;

vm.runInNewContext(source, sandbox, { filename: 'dist/client.js' });

assert.equal(registrations.length, 1, 'the bundle must register exactly one module');
const [registration] = registrations;
assert.equal(registration.id, packageName, 'the registered id must be the package name');
assert.equal(typeof registration.factory, 'function', 'the registration must carry a factory');

// Platform seed words the page provides to a factory (see staticModules in the shell).
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  createContext: (value) => ({ Provider: 'P', value }),
  Fragment: 'Fragment',
  useState: (init) => [typeof init === 'function' ? init() : init, noop],
  useEffect: noop,
  useLayoutEffect: noop,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  memo: (component) => component,
  forwardRef: (fn) => fn,
  isValidElement: () => false,
  version: '19.0.0',
};
const seeds = { react, 'react/jsx-runtime': { jsx: noop, jsxs: noop, Fragment: 'Fragment' } };
const plugin = registration.factory((specifier) => {
  if (!(specifier in seeds)) throw new Error(`factory required "${specifier}", which is not a platform seed here`);
  return seeds[specifier];
});

assert.equal(typeof plugin, 'object', 'the factory must return the plugin object');
assert.ok(plugin !== null, 'the factory must not return null');
assert.equal(typeof plugin.apply, 'function', 'the plugin must expose apply()');
assert.ok(Array.isArray(plugin.inject), 'the plugin must declare inject as an array');

// A throwing apply is the other way to dead-end an entry; activation is exercised
// with a minimal ctx double so a regression there shows up offline.
const effects = [];
const ctx = {
  logger: { warn: noop, info: noop, error: noop },
  effect: (step, label) => {
    effects.push({ label, dispose: typeof step === 'function' ? step() : undefined });
    return noop;
  },
  slots: { inject: () => noop, register: () => noop, registerFactory: () => noop },
  locale: { register: () => noop },
};
plugin.apply(ctx);
assert.ok(effects.length >= 1, 'apply must register at least one effect');

console.log(`ok   ${bundlePath}`);
console.log(`ok   id=${registration.id} apply=${typeof plugin.apply} inject=${JSON.stringify(plugin.inject)}`);
console.log(`ok   activation registered ${effects.length} effect(s)`);
