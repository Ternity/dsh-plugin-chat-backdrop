/**
 * dsh-plugin-chat-backdrop — persistence and scope resolution, DOM-free.
 *
 * Kept separate from src/client.template.js so tools/test-store.mjs can import
 * it in Node and check the migration and merge rules the bundle relies on.
 * tools/build-client.mjs inlines this file into dist/client.js (the `export`
 * keywords are stripped there), so the shipped bundle stays a classic script.
 *
 * Storage shape (v2):
 *
 *   {
 *     v: 2,
 *     default: { <any subset of DEFAULTS> },         // the default background
 *     workspaces: { [workspaceId]: { <subset> } },   // per-project overrides
 *   }
 *
 * v1 was one flat object (a single global config); loadStore migrates it into
 * `default`, so a user's current picture and opacity simply become the default.
 */

export const STORAGE_VERSION = 2;
export const DEFAULT_SCOPE = 'default';

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Keep only known keys whose value matches the default value's type. */
export function sanitizeConfig(raw, defaults) {
  const clean = {};
  if (!isPlainObject(raw)) return clean;
  for (const key of Object.keys(defaults)) {
    if (!hasOwn(raw, key)) continue;
    const value = raw[key];
    const fallback = defaults[key];
    if (typeof value !== typeof fallback) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    clean[key] = value;
  }
  return clean;
}

export function emptyStore() {
  return { v: STORAGE_VERSION, default: {}, workspaces: {} };
}

/** Accept a parsed localStorage value of any version and return a v2 store. */
export function normalizeStore(parsed, defaults) {
  if (!isPlainObject(parsed)) return emptyStore();

  if (parsed.v === STORAGE_VERSION) {
    const store = emptyStore();
    store.default = sanitizeConfig(parsed.default, defaults);
    if (isPlainObject(parsed.workspaces)) {
      for (const id of Object.keys(parsed.workspaces)) {
        if (!id || UNSAFE_KEYS.has(id)) continue;
        const clean = sanitizeConfig(parsed.workspaces[id], defaults);
        if (Object.keys(clean).length > 0) store.workspaces[id] = clean;
      }
    }
    return store;
  }

  // v1 (or garbage without a version): the whole object was one global config.
  const migrated = emptyStore();
  migrated.default = sanitizeConfig(parsed, defaults);
  return migrated;
}

/** Merge DEFAULTS with one or more partial layers, ignoring unknown keys. */
export function mergeConfig(defaults, ...layers) {
  const merged = { ...defaults };
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    for (const key of Object.keys(defaults)) {
      if (hasOwn(layer, key)) merged[key] = layer[key];
    }
  }
  return merged;
}

/**
 * Create the store over a storage-like object ({ getItem, setItem }), so the
 * browser passes window.localStorage and a test passes a Map-backed stub.
 */
export function createBackdropStore({ storage, key, defaults }) {
  const listeners = new Set();
  let cache = emptyStore();

  function readFromStorage() {
    try {
      const raw = storage.getItem(key);
      return raw ? normalizeStore(JSON.parse(raw), defaults) : emptyStore();
    } catch {
      return emptyStore();
    }
  }

  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A broken listener must not stop the others.
      }
    }
  }

  cache = readFromStorage();

  const store = {
    get raw() {
      return cache;
    },

    /** Re-read localStorage (migration for an older value happens here). */
    reload() {
      cache = readFromStorage();
      notify();
      return store;
    },

    /** Workspace ids that currently carry an override. */
    list() {
      return Object.keys(cache.workspaces);
    },

    defaultConfig() {
      return mergeConfig(defaults, cache.default);
    },

    effectiveFor(scopeId) {
      if (!scopeId || scopeId === DEFAULT_SCOPE) {
        return mergeConfig(defaults, cache.default);
      }
      return mergeConfig(defaults, cache.default, cache.workspaces[scopeId]);
    },

    /** The raw override of one workspace (null when it inherits the default). */
    overrideOf(scopeId) {
      if (!scopeId || scopeId === DEFAULT_SCOPE) return null;
      return cache.workspaces[scopeId] || null;
    },

    hasOverride(scopeId) {
      const override = store.overrideOf(scopeId);
      return Boolean(override && Object.keys(override).length > 0);
    },

    /** Whether one field is set by the override itself (not inherited). */
    owns(scopeId, field) {
      const override = store.overrideOf(scopeId);
      return Boolean(override && hasOwn(override, field));
    },

    /** Patch one scope. `undefined` values delete that field from the scope. */
    write(scopeId, patch) {
      if (!isPlainObject(patch)) return store.effectiveFor(scopeId);
      const scope = !scopeId ? DEFAULT_SCOPE : scopeId;
      if (scope !== DEFAULT_SCOPE && UNSAFE_KEYS.has(scope)) return store.effectiveFor(scope);
      const target = scope === DEFAULT_SCOPE
        ? cache.default
        : (cache.workspaces[scope] || (cache.workspaces[scope] = {}));
      for (const field of Object.keys(patch)) {
        if (!hasOwn(defaults, field)) continue;
        if (patch[field] === undefined) delete target[field];
        else target[field] = patch[field];
      }
      if (scope !== DEFAULT_SCOPE && Object.keys(target).length === 0) {
        delete cache.workspaces[scope];
      }
      notify();
      return store.effectiveFor(scope);
    },

    /** Drop a workspace's whole override, so it inherits the default again. */
    clear(scopeId) {
      if (scopeId && scopeId !== DEFAULT_SCOPE) delete cache.workspaces[scopeId];
      notify();
      return store.effectiveFor(scopeId);
    },

    /** Back to factory defaults (also used by the settings row's reset). */
    reset() {
      cache = emptyStore();
      notify();
      return store.effectiveFor(DEFAULT_SCOPE);
    },

    /** Returns false when the write failed (quota / private mode). */
    persist() {
      try {
        storage.setItem(key, JSON.stringify(cache));
        return true;
      } catch {
        return false;
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return store;
}
