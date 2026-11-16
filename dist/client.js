'use strict';

/*
 * dsh-plugin-chat-backdrop — browser half.
 *
 * Registers a lazy CJS factory through the client module loader, the same path
 * the shipped `@deepseek-ai/dsh-client-*` packages and third-party plugins such
 * as `ds-harness-remote` use. `id` must equal the package name.
 *
 * What it does: paints a wallpaper behind the conversation column and makes the
 * surfaces over it translucent, so the picture shows through while the theme's
 * own colours keep the text readable. The picture and its opacity are set per
 * SCOPE: one default for every workspace, plus optional per-workspace overrides.
 *
 * How, and why this way
 * ---------------------
 * The surfaces that matter each paint themselves from ONE theme token, and those
 * tokens can be rebound on a subtree:
 *
 *   conversation column  div:has(> [data-slot="conversation.content"])  (no bg of its own)
 *   user bubble          var(--dsw-specific-bubble)
 *   composer card        var(--dsw-specific-input-major)   [data-composer-card]
 *   composer fade band   var(--dsw-alias-bg-base)          [data-composer-seat]
 *
 * So the plugin rebinds variables instead of fighting selectors, and every hook
 * it uses is a `data-*` attribute or a `data-slot` key rather than a generated
 * class name (DSH's CSS-module classes are content-hashed and change per build).
 *
 * The two rebinding rules, both learned the hard way:
 *   1. never define a variable in terms of itself on the same element (that is a
 *      cycle and the whole declaration is dropped), so derived colours are
 *      computed on <body> under fresh `--dshx-cb-*` names and only then assigned
 *      to the official name deeper down;
 *   2. never touch the `--dsw-alias-*` tokens on <body> itself — the theme
 *      presenter writes them as inline styles, so a stylesheet cannot win, and
 *      they are shared with modals, menus and tooltips.
 *
 * Per-workspace switching needs three pieces, none of which touch the CSS above:
 *   - src/backdrop-store.js (inlined below) holds the v2 storage shape, migrates
 *     the old flat config into the default scope, and resolves a scope to the
 *     effective values;
 *   - a controller in the `conversation.composer.dock` slot reads the current
 *     session's workspace through the standard `useWorkspaces` prop and applies
 *     that scope, falling back to the default when there is no session yet;
 *   - Settings → General gains an `Applies to` selector so a row can edit either
 *     the default or one workspace without needing to know which is current.
 *
 * Play with it from the renderer console (values persist to localStorage):
 *
 *   __DSH_CHAT_BACKDROP__.config                            // effective values now
 *   __DSH_CHAT_BACKDROP__.setConfig({ opacity: 0.85 })      // edit the default
 *   __DSH_CHAT_BACKDROP__.update('<workspaceId>', { opacity: 0.4 })  // override one
 *   __DSH_CHAT_BACKDROP__.clearScope('<workspaceId>')       // drop that override
 *   __DSH_CHAT_BACKDROP__.reset()
 */

(() => {
  const MODULE_ID = 'dsh-plugin-chat-backdrop';
  const STYLE_ID = 'dsh-chat-backdrop-style';
  const STORAGE_KEY = 'dsh.chatBackdrop';

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

const STORAGE_VERSION = 2;
const DEFAULT_SCOPE = 'default';

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Keep only known keys whose value matches the default value's type. */
function sanitizeConfig(raw, defaults) {
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

function emptyStore() {
  return { v: STORAGE_VERSION, default: {}, workspaces: {} };
}

/** Accept a parsed localStorage value of any version and return a v2 store. */
function normalizeStore(parsed, defaults) {
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
function mergeConfig(defaults, ...layers) {
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
function createBackdropStore({ storage, key, defaults }) {
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


  /** Inlined by tools/build-client.mjs from assets/backdrop.webp. */
  const IMAGE = 'data:image/webp;base64,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';

  /**
   * Everything a scope can change lives here, and every value can also be set
   * from the renderer console through the `window.__DSH_CHAT_BACKDROP__` handle.
   * Values persist to localStorage under `dsh.chatBackdrop`; a custom picture
   * rides along as a data URL, which is why the row downscales a picked file
   * before storing it.
   */
  const DEFAULTS = {
    /**
     * How strongly the picture shows through: 0 = only the theme surface (no
     * wallpaper), 1 = picture with no wash at all. The slider in Settings →
     * General drives exactly this value; the veil painted over the picture is
     * `1 - opacity`.
     */
    opacity: 0.62,
    /** Picture picked in Settings → General, as a data URL. Empty = built-in. */
    imageUrl: '',
    /** Display name of the picked file (cosmetic only). */
    imageName: '',
    /** Extra black wash over the picture, 0..1 (bright pictures only). */
    imageDim: 0,
    imageSize: 'cover',
    imagePosition: 'center',
    /** Share of the theme colour kept in the user bubble / composer card. */
    bubbleKeep: 0.78,
    cardKeep: 0.84,
    /** Frost radius on the composer card, in px (0 = off). */
    cardBlur: 14,
    /** Cover the right sidebar's embedded subagent conversations too. */
    embedded: false,
  };

  const STYLESHEET = `
    /* ── knobs ──────────────────────────────────────────────────────────────
       Set by JS as inline custom properties on <html>; the defaults here keep
       the stylesheet harmless if JS never runs. */
    :root {
      --dshx-cb-image: none;
      --dshx-cb-dim: 0;
      --dshx-cb-size: cover;
      --dshx-cb-position: center;
      --dshx-cb-veil: 38%;
      --dshx-cb-bubble-keep: 78%;
      --dshx-cb-card-keep: 84%;
      --dshx-cb-card-blur: 14px;
    }

    /* ── derived colours ────────────────────────────────────────────────────
       Computed on <body>, which is where the theme declares
       --dsw-alias-bg-base / --dsw-specific-*; <html> cannot see them, custom
       properties only inherit downwards. Fresh names avoid self-reference
       cycles when they are assigned back to the official tokens below. */
    body {
      --dshx-cb-surface: color-mix(in srgb, var(--dsw-alias-bg-base) var(--dshx-cb-veil), transparent);
      --dshx-cb-bubble: color-mix(in srgb, var(--dsw-specific-bubble) var(--dshx-cb-bubble-keep), transparent);
      --dshx-cb-card: color-mix(in srgb, var(--dsw-specific-input-major) var(--dshx-cb-card-keep), transparent);
    }

    /* ── the wallpaper ──────────────────────────────────────────────────────
       Three layers: themed veil, optional black wash, then the picture.
       The element is not a scroll container (the scroller lives inside it), so
       'scroll' behaves like a fixed backdrop without the fixed-attachment
       quirks under transformed/backdrop-filter ancestors. */
    html[data-dsh-chat-backdrop="1"] [data-conversation-content] {
      background-image:
        linear-gradient(var(--dshx-cb-surface), var(--dshx-cb-surface)),
        linear-gradient(rgba(0, 0, 0, var(--dshx-cb-dim)), rgba(0, 0, 0, var(--dshx-cb-dim))),
        var(--dshx-cb-image);
      background-size: auto, auto, var(--dshx-cb-size);
      background-position: center, center, var(--dshx-cb-position);
      background-repeat: no-repeat, no-repeat, no-repeat;
      background-attachment: scroll, scroll, scroll;
    }

    /* Embedded subagent conversations live in the right column; leave them alone
       unless explicitly asked, they are small and their own colour reads better. */
    html:not([data-dsh-chat-backdrop-embedded]) [data-rightbar-col] [data-conversation-content] {
      background-image: none;
    }

    /* ── translucent surfaces ───────────────────────────────────────────────
       Rebind the token each surface already consumes. Nothing here needs
       !important: we are not fighting the official rules for a property, we are
       changing the value of a variable they read, closer to the consumer than
       the theme's own declaration. */
    [data-conversation-content] { --dsw-specific-bubble: var(--dshx-cb-bubble); }

    [data-composer-card] {
      --dsw-specific-input-major: var(--dshx-cb-card);
      backdrop-filter: blur(var(--dshx-cb-card-blur)) saturate(140%);
      -webkit-backdrop-filter: blur(var(--dshx-cb-card-blur)) saturate(140%);
    }

    /* The composer seat paints a fade-to-solid band with --dsw-alias-bg-base;
       inside the seat only, that token becomes the translucent surface so the
       fade stays but no longer cuts the wallpaper off with a solid strip. */
    [data-composer-seat] { --dsw-alias-bg-base: var(--dshx-cb-surface); }

    /* ── the Settings → General rows ─────────────────────────────────────────
       Copied from the host's own General row (ui-conversation's
       EnterBehaviorRow.module.css: .row/.rowText/.title/.desc/.selector) and
       renamed under this plugin's prefix, which is what
       references/practices.md prescribes — the host's class names are
       content-hashed and its primitives must not be imported as modules, so
       markup and CSS are copied and only the --dsw-alias-* tokens stay shared.
       (No backticks in this comment either: this CSS lives in a JS template
       literal.) */
    .dshx-cb-row {
      display: flex; align-items: center; gap: 8px; padding: 16px 0;
      border-bottom: 0.5px solid var(--dsw-alias-border-l2);
    }
    /* The section owner already strips the hairline from the slot anchor's last
       child; repeating it here keeps things right if that ever changes. */
    .dshx-cb-row:last-child { border-bottom: none; }
    .dshx-cb-text {
      display: flex; flex-direction: column; flex: 1;
      gap: 4px; min-width: 0; padding-right: 48px;
    }
    .dshx-cb-title {
      color: var(--dsw-alias-label-primary);
      font-size: 14px; font-weight: 400; line-height: 22px;
    }
    .dshx-cb-desc {
      color: var(--dsw-alias-label-tertiary);
      font-size: 12px; font-weight: 400; line-height: 18px;
    }
    .dshx-cb-actions { display: inline-flex; align-items: center; gap: 8px; flex: none; }
    /* The General row's own control chrome: a 36px pill on the module fill. */
    .dshx-cb-choose {
      display: inline-flex; align-items: center; gap: 12px;
      height: 36px; padding: 0 14px; border: none;
      border-radius: var(--dsw-radius-md);
      background: var(--dsw-alias-bg-module-platform);
      color: var(--dsw-alias-label-primary);
      font: inherit; font-size: 14px; line-height: 22px; white-space: nowrap;
      cursor: pointer;
    }
    .dshx-cb-choose:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
    .dshx-cb-choose:disabled { opacity: 0.4; cursor: not-allowed; }
    .dshx-cb-choose:focus-visible {
      outline: var(--dsw-focus-ring-width) solid
        var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
      outline-offset: 1px;
    }
    /* Scope selector: the same pill, sized for a native select. */
    .dshx-cb-select {
      height: 36px; padding: 0 34px 0 14px; border: none;
      border-radius: var(--dsw-radius-md);
      background: var(--dsw-alias-bg-module-platform);
      color: var(--dsw-alias-label-primary);
      font: inherit; font-size: 14px; line-height: 22px;
      max-width: 340px; cursor: pointer;
    }
    .dshx-cb-select:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .dshx-cb-select:focus-visible {
      outline: var(--dsw-focus-ring-width) solid
        var(--dshx-cb-choose-focus-ring, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)));
      outline-offset: 1px;
    }
    /* Quiet reset affordance, as in the host's settings fields (.reset). */
    .dshx-cb-reset {
      border: none; background: none; padding: 0;
      font: inherit; font-size: 12px; line-height: 1.5;
      color: var(--dsw-alias-label-secondary); cursor: pointer;
    }
    .dshx-cb-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
    .dshx-cb-reset:disabled { opacity: 0.5; cursor: default; }
    .dshx-cb-slider { width: 168px; accent-color: var(--dsw-alias-brand-primary); }
    .dshx-cb-value {
      min-width: 44px; text-align: right;
      color: var(--dsw-alias-label-tertiary);
      font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums;
    }
    /* The swatch paints the same three layers as the wallpaper, but from its OWN
       local variables so it can preview the selected scope even when that scope
       is not the one currently applied. The surface mix is computed here (not
       inherited from <body>) because a custom property that was already
       substituted on <body> cannot be re-mixed further down. */
    .dshx-cb-preview {
      flex: 0 0 auto; width: 64px; height: 36px;
      border-radius: var(--dsw-radius-md);
      border: 0.5px solid var(--dsw-alias-border-l2);
      --dshx-cb-local-surface: color-mix(
        in srgb,
        var(--dsw-alias-bg-base) var(--dshx-cb-local-veil, var(--dshx-cb-veil)),
        transparent
      );
      background-image:
        linear-gradient(var(--dshx-cb-local-surface), var(--dshx-cb-local-surface)),
        linear-gradient(
          rgba(0, 0, 0, var(--dshx-cb-local-dim, var(--dshx-cb-dim))),
          rgba(0, 0, 0, var(--dshx-cb-local-dim, var(--dshx-cb-dim)))
        ),
        var(--dshx-cb-local-image, var(--dshx-cb-image));
      background-size: auto, auto, cover;
      background-position: center, center, center;
      background-repeat: no-repeat, no-repeat, no-repeat;
    }
  `;

  // ── store, scope and application ─────────────────────────────────────────

  /**
   * Built on first use rather than at module evaluation: the client-plugin model
   * keeps module bodies free of side effects, and reading localStorage is one.
   * Nothing visible happens until apply() runs anyway.
   */
  let store = null;
  function getStore() {
    if (store === null) {
      store = createBackdropStore({ storage: window.localStorage, key: STORAGE_KEY, defaults: DEFAULTS });
    }
    return store;
  }

  /** The workspace of the visible main conversation, set by the controller. */
  let activeWorkspaceId;

  let persistTimer = 0;
  let pendingPersist = false;

  /**
   * Deferred writes.
   *
   * Dragging the opacity slider fires an input event per pixel, and the stored
   * value carries every picked picture as a data URL, so persisting every tick
   * would re-serialize hundreds of KB dozens of times a second. Continuous
   * updates apply to the DOM immediately and only the last one is written,
   * 350 ms after the drag stops (or on release / unmount).
   */
  function flushPersist() {
    if (persistTimer) {
      window.clearTimeout(persistTimer);
      persistTimer = 0;
    }
    if (!pendingPersist) return;
    pendingPersist = false;
    api.persisted = getStore().persist();
  }

  function schedulePersist() {
    pendingPersist = true;
    if (persistTimer) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      persistTimer = 0;
      flushPersist();
    }, 350);
  }

  function commitPersist(options) {
    if (options && options.persist === false) {
      schedulePersist();
      return;
    }
    if (persistTimer) {
      window.clearTimeout(persistTimer);
      persistTimer = 0;
    }
    pendingPersist = false;
    api.persisted = getStore().persist();
  }

  function applyConfig(config) {
    const root = document.documentElement;
    const set = (name, value) => root.style.setProperty(name, value);
    const percent = (value) => `${(Math.min(1, Math.max(0, Number(value) || 0)) * 100).toFixed(1)}%`;
    // A picked picture wins over the built-in one.
    set('--dshx-cb-image', `url("${config.imageUrl || IMAGE}")`);
    set('--dshx-cb-size', String(config.imageSize));
    set('--dshx-cb-position', String(config.imagePosition));
    set('--dshx-cb-dim', String(Math.min(1, Math.max(0, Number(config.imageDim) || 0))));
    set('--dshx-cb-veil', percent(1 - Number(config.opacity)));
    set('--dshx-cb-bubble-keep', percent(config.bubbleKeep));
    set('--dshx-cb-card-keep', percent(config.cardKeep));
    set('--dshx-cb-card-blur', `${Math.max(0, Number(config.cardBlur) || 0)}px`);
    root.dataset.dshChatBackdrop = '1';
    if (config.embedded) root.dataset.dshChatBackdropEmbedded = '1';
    else delete root.dataset.dshChatBackdropEmbedded;
  }

  function clearConfig() {
    const root = document.documentElement;
    for (const name of [
      '--dshx-cb-image', '--dshx-cb-size', '--dshx-cb-position', '--dshx-cb-dim',
      '--dshx-cb-veil', '--dshx-cb-bubble-keep', '--dshx-cb-card-keep', '--dshx-cb-card-blur',
    ]) {
      root.style.removeProperty(name);
    }
    delete root.dataset.dshChatBackdrop;
    delete root.dataset.dshChatBackdropEmbedded;
  }

  /** Push the active scope's effective values into the document. */
  function applyEffective() {
    applyConfig(getStore().effectiveFor(activeWorkspaceId));
  }

  function setActiveWorkspace(workspaceId) {
    const next = workspaceId || undefined;
    if (next === activeWorkspaceId) return;
    activeWorkspaceId = next;
    applyEffective();
  }

  function setActiveWorkspaceIfCurrent(workspaceId, next) {
    if (activeWorkspaceId !== (workspaceId || undefined)) return;
    setActiveWorkspace(next);
  }

  function installStyle() {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // data-plugin marks the tag as ours: the client module registry reclaims
    // styles by attribute, and it also adopts untagged styles for whichever
    // plugin materialized first, so tagging is not optional.
    style.dataset.plugin = MODULE_ID;
    style.dataset.pluginCss = `${MODULE_ID}/backdrop.css`;
    style.textContent = STYLESHEET;
    document.head.append(style);
    return () => style.remove();
  }

  /** Console handle: read and edit scopes without a reload. */
  const api = {
    active: true,
    /** false once a write failed (private mode, or an image past the quota). */
    persisted: true,

    /** Effective values of the scope currently applied (the visible conversation). */
    get config() {
      return getStore().effectiveFor(activeWorkspaceId);
    },
    /** Workspace id driving the wallpaper right now, or DEFAULT_SCOPE. */
    get scope() {
      return activeWorkspaceId || DEFAULT_SCOPE;
    },
    /** Effective values of the default scope. */
    get defaultConfig() {
      return getStore().defaultConfig();
    },

    effectiveFor(scopeId) {
      return getStore().effectiveFor(scopeId);
    },
    overrideOf(scopeId) {
      return getStore().overrideOf(scopeId);
    },
    hasOverride(scopeId) {
      return getStore().hasOverride(scopeId);
    },
    owns(scopeId, field) {
      return getStore().owns(scopeId, field);
    },
    workspaces() {
      return getStore().list();
    },

    /**
     * Patch one scope and persist it. `{ persist: false }` keeps the change live
     * but defers the write (coalesced) — used while a slider is being dragged.
     */
    update(scopeId, patch, options) {
      const scope = scopeId || DEFAULT_SCOPE;
      getStore().write(scope, patch);
      commitPersist(options);
      return getStore().effectiveFor(scope);
    },

    /** Back-compat for the console handle: `setConfig` edits the default scope. */
    setConfig(patch, options) {
      return api.update(DEFAULT_SCOPE, patch, options);
    },

    /** Drop one workspace override so it inherits the default again. */
    clearScope(scopeId) {
      getStore().clear(scopeId);
      commitPersist();
      return getStore().effectiveFor(scopeId);
    },

    /** Wipe everything back to factory defaults. */
    reset() {
      if (persistTimer) {
        window.clearTimeout(persistTimer);
        persistTimer = 0;
      }
      pendingPersist = false;
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      getStore().reset();
      api.persisted = true;
      return getStore().effectiveFor(activeWorkspaceId);
    },
  };

  function start(ctx) {
    // Everything is registered as an effect, so cordis tears it all down when
    // the plugin is disabled, reloaded (HMR) or removed.
    ctx.effect(() => installStyle(), `${MODULE_ID}: backdrop stylesheet`);
    ctx.effect(() => {
      const unsubscribe = getStore().subscribe(() => applyEffective());
      applyEffective();
      return () => {
        unsubscribe();
        flushPersist();
        clearConfig();
      };
    }, `${MODULE_ID}: backdrop variables`);
    ctx.effect(() => {
      window.__DSH_CHAT_BACKDROP__ = api;
      return () => { delete window.__DSH_CHAT_BACKDROP__; };
    }, `${MODULE_ID}: console handle`);
  }

  // ── workspace controller ─────────────────────────────────────────────────

  /**
   * True when this slot instance belongs to the visible main conversation.
   *
   * `conversation.composer.dock` is session-scoped, so the right sidebar's
   * embedded subagent conversations mount it too; only the main one may decide
   * the wallpaper. `[data-conversation-content]` with `data-conversation-session`
   * is the host's own contract for "which session is rendered here", and the
   * right column is marked by `[data-rightbar-col]`.
   */
  function isMainConversation(sessionId) {
    try {
      const hosts = Array.from(document.querySelectorAll('[data-conversation-content]'));
      if (hosts.length === 0) return true;
      const main = hosts.find((element) => !element.closest('[data-rightbar-col]'));
      if (!main) return true;
      const current = main.getAttribute('data-conversation-session');
      return current === null || current === undefined || current === sessionId;
    } catch {
      return true;
    }
  }

  function createController(React) {
    return function BackdropController(props) {
      const sessionId = props ? props.sessionId : undefined;
      const useWorkspaces = props && typeof props.useWorkspaces === 'function' ? props.useWorkspaces : null;
      // The standard prop is a selector hook; the selector must return a stable
      // value (a workspace id), never a fresh object, or React would re-render
      // on every store publication.
      const workspaceId = useWorkspaces
        ? useWorkspaces((snapshot) => {
            if (!snapshot || !Array.isArray(snapshot.items) || sessionId === undefined) return undefined;
            const owner = snapshot.items.find(
              (item) => item && Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId),
            );
            return owner ? owner.workspaceId : undefined;
          })
        : undefined;

      React.useEffect(() => {
        if (!isMainConversation(sessionId)) return undefined;
        setActiveWorkspace(workspaceId);
        return () => {
          // A dep change mounts the next effect right after this cleanup; the
          // guard keeps an unmounting embedded instance from clearing the main
          // conversation's scope.
          setActiveWorkspaceIfCurrent(workspaceId, undefined);
        };
      }, [workspaceId]);

      return null;
    };
  }

  // ── self-check probe ────────────────────────────────────────────────────

  /**
   * Zero-space occupant whose slot id carries a one-line self-check, readable
   * from outside the page:
   *
   *   chat-backdrop-diag-s<a>a<b>i<c>v<d>h<e>c<f>o<g>u<h>w<i>b<j>s<k>-g0/1k<hash>-<theme>-<has>
   *
   *   s  the injected <style data-plugin="…"> tag is in the document
   *   a  <html data-dsh-chat-backdrop="1"> is set
   *   i  --dshx-cb-image resolves to something on <html>
   *   v  --dshx-cb-surface resolves to something on <body>
   *   h  the main [data-conversation-content] computes a background-image with a picture
   *   c  composer card alpha x100 (0-99 translucent, 100 opaque, x no card)
   *   o  effective opacity x100 for the active scope
   *   u  1 when a custom picture (not the built-in one) is in use
   *   w  canvas can encode WebP        b  createImageBitmap exists        s  localStorage writable
   *   g  1 when the active workspace has its own override
   *   k  six hex chars hashing the active workspace id, or d for the default scope
   *   t  1/0/- : runtime override-plumbing self-test (passed / failed / no workspace)
   *   theme: dark | light   has: whether this engine supports :has()
   *
   * Read it with:
   *   cordis_inspect_query platform=client provider=Slots method=listSubTree
   *                      input={"root":"conversation.composer.dock"}
   *
   * It is a self-check, not a feature: if a future DSH build renames the hooks
   * this is what says which step broke.
   */
  function alphaOf(value) {
    if (!value) return 1;
    const slash = /\/\s*([\d.]+)(%?)\s*\)/.exec(value); // color(srgb r g b / a)
    if (slash) return slash[2] === '%' ? parseFloat(slash[1]) / 100 : parseFloat(slash[1]);
    const rgba = /^rgba\(([^)]+)\)$/.exec(value);
    if (rgba) {
      const parts = rgba[1].split(',').map((part) => part.trim());
      return parts.length === 4 ? parseFloat(parts[3]) : 1;
    }
    return 1; // rgb(...) / named colour: opaque
  }

  /** Six hex chars of an FNV-1a hash, so the slot id stays short and safe. */
  function hash6(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0').slice(0, 6);
  }

  /**
   * Runtime proof that the override plumbing works, reported as one diag bit.
   *
   * It writes a synthetic override for the active workspace, checks that the
   * effective values pick it up, then deletes it again — all synchronously, so
   * nothing is painted in between and localStorage is never touched (store.write
   * only mutates the cache; persisting is a separate call). Skipped when the
   * user already has a real override on this workspace, because the synthetic
   * patch must not disturb it.
   */
  function selfTestOverrides() {
    const scope = activeWorkspaceId;
    if (!scope) return '-';
    if (getStore().hasOverride(scope)) return '-';
    let result = '0';
    try {
      getStore().write(scope, { opacity: 0.123 });
      result = getStore().effectiveFor(scope).opacity === 0.123 ? '1' : '0';
    } catch {
      result = '0';
    } finally {
      try {
        const override = getStore().overrideOf(scope);
        const onlySynthetic = override
          && Object.keys(override).length === 1
          && override.opacity === 0.123;
        if (onlySynthetic) getStore().write(scope, { opacity: undefined });
      } catch {
        /* the synthetic patch is best-effort; a leftover override only ever
           equals the user's own opacity scale, never a picture */
      }
    }
    return result;
  }

  function diagnose() {
    const globalCss = window.CSS;
    const supportsHas = Boolean(globalCss) && typeof globalCss.supports === 'function'
      && globalCss.supports('selector(:has(*))');
    const theme = document.body && document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
    const bit = (value) => (value ? '1' : '0');
    const styleTag = bit(document.querySelector(`style[data-plugin="${MODULE_ID}"]`));
    const attr = bit(document.documentElement.getAttribute('data-dsh-chat-backdrop'));
    const imageVar = bit(getComputedStyle(document.documentElement).getPropertyValue('--dshx-cb-image').trim());
    const surfaceVar = bit(document.body
      && getComputedStyle(document.body).getPropertyValue('--dshx-cb-surface').trim());

    const contentHosts = Array.from(document.querySelectorAll('[data-conversation-content]'));
    const host = contentHosts.find((element) => !element.closest('[data-rightbar-col]')) || contentHosts[0];
    let painted = false;
    if (host) {
      try {
        painted = /image\/webp/.test(getComputedStyle(host).backgroundImage || '');
      } catch {
        painted = false;
      }
    }
    const card = document.querySelector('[data-composer-card]');
    let cardAlpha = 'x';
    if (card) {
      try {
        cardAlpha = String(Math.round(alphaOf(getComputedStyle(card).backgroundColor) * 100));
      } catch {
        cardAlpha = 'x';
      }
    }

    const applied = getStore().effectiveFor(activeWorkspaceId);
    const opacity = String(Math.round(Number(applied.opacity) * 100));
    const custom = bit(Boolean(applied.imageUrl));
    const overridden = bit(getStore().hasOverride(activeWorkspaceId));
    const scopeKey = activeWorkspaceId ? hash6(String(activeWorkspaceId)) : 'd';

    // Capabilities the Settings row depends on: WebP encoding from a canvas,
    // createImageBitmap for decoding a picked File, and a writable localStorage.
    const canWebp = (() => {
      try {
        return document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp');
      } catch {
        return false;
      }
    })();
    const canBitmap = typeof window.createImageBitmap === 'function';
    const canStore = (() => {
      try {
        window.localStorage.setItem(`${STORAGE_KEY}.selftest`, '1');
        window.localStorage.removeItem(`${STORAGE_KEY}.selftest`);
        return true;
      } catch {
        return false;
      }
    })();

    return `s${styleTag}a${attr}i${imageVar}v${surfaceVar}`
      + `h${bit(painted)}c${cardAlpha}o${opacity}u${custom}`
      + `w${bit(canWebp)}b${bit(canBitmap)}s${bit(canStore)}`
      + `-g${overridden}k${scopeKey}t${selfTestOverrides()}`
      + `-${theme}-${supportsHas ? 'has' : 'nohas'}`;
  }

  function registerProbes(ctx, React) {
    const register = (id, component) => ctx.slots.inject(PROBE_SLOT, () => ctx.slots.register(
      { name: PROBE_SLOT, id, order: 100 },
      component,
    ));
    // The controller lives in this seat: it is session-scoped, its standard
    // props include sessionId/useWorkspaces, and it renders nothing.
    register('chat-backdrop', createController(React));
    ctx.effect(() => {
      let dispose;
      const timer = window.setTimeout(() => {
        dispose = register(`chat-backdrop-diag-${diagnose()}`, function BackdropProbe() { return null; });
      }, 3000);
      return () => {
        window.clearTimeout(timer);
        if (typeof dispose === 'function') dispose();
      };
    }, `${MODULE_ID}: diagnostics probe`);
  }

  const PROBE_SLOT = 'conversation.composer.dock';

  // ── copy ────────────────────────────────────────────────────────────────

  const LANG = String(document.documentElement.lang || navigator.language || 'zh').toLowerCase();
  const DICT = {
    zh: {
      scopeTitle: '作用范围',
      scopeDefaultOption: '默认（所有工作区）',
      scopeDescDefault: '未单独设置的工作区都使用这套背景',
      scopeDescInherit: '此工作区尚未单独设置（继承默认）',
      scopeDescOverride: '此工作区已单独设置',
      currentSuffix: '（当前）',
      imageTitle: '对话背景图',
      imageDescBuiltin: '内置图',
      imageDescCustom: '本地图片：',
      imageUntitled: '自定义图片',
      inheritPrefix: '继承默认 · ',
      pick: '选择图片…',
      picking: '读取中…',
      resetImage: '恢复默认图',
      useDefaultImage: '用默认图',
      opacityTitle: '背景图透明度',
      opacityDesc: '0% 只有主题底色（等于关闭），100% 图片最清楚',
      followDefault: '跟随默认',
      resetAll: '全部恢复默认',
      failed: '这张图片读不出来',
      quota: '图片太大，只能在本次会话生效（未能持久化）',
    },
    en: {
      scopeTitle: 'Applies to',
      scopeDefaultOption: 'Default (all workspaces)',
      scopeDescDefault: 'Workspaces without their own setting use this backdrop',
      scopeDescInherit: 'This workspace inherits the default',
      scopeDescOverride: 'This workspace has its own setting',
      currentSuffix: ' (current)',
      imageTitle: 'Chat backdrop image',
      imageDescBuiltin: 'Built-in picture',
      imageDescCustom: 'Local picture: ',
      imageUntitled: 'custom picture',
      inheritPrefix: 'inherited · ',
      pick: 'Choose image…',
      picking: 'Reading…',
      resetImage: 'Use built-in',
      useDefaultImage: 'Use default picture',
      opacityTitle: 'Backdrop opacity',
      opacityDesc: '0% keeps only the theme colour (same as off), 100% shows the picture fully',
      followDefault: 'Follow default',
      resetAll: 'Reset all',
      failed: 'This picture could not be read',
      quota: 'Picture too large to persist — applies to this session only',
    },
  };
  /** Used until (or in case) the locale service hands the component a `t`. */
  const FALLBACK_COPY = LANG.startsWith('zh') ? DICT.zh : DICT.en;

  // ── picked-file handling ────────────────────────────────────────────────

  /** Decode a picked File without needing a blob: URL (CSP-proof). */
  async function decodeImage(file) {
    if (typeof window.createImageBitmap === 'function') {
      try {
        return await window.createImageBitmap(file);
      } catch {
        /* fall through to the <img> path */
      }
    }
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(FALLBACK_COPY.failed));
        image.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Turn a picked picture into a data URL small enough for localStorage.
   * localStorage holds ~5 MB per origin and a data URL is ~1.37x the bytes, so
   * the file is downscaled to 2400 px on its long edge and re-encoded; a small
   * photo keeps its quality, an 8000 px screenshot shrinks by an order of
   * magnitude without visibly mattering behind a chat column.
   */
  async function encodeImage(file) {
    const bitmap = await decodeImage(file);
    try {
      const width = bitmap.width || bitmap.naturalWidth || 1;
      const height = bitmap.height || bitmap.naturalHeight || 1;
      const scale = Math.min(1, 2400 / Math.max(width, height));
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas unavailable');
      context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
      let dataUrl = canvas.toDataURL('image/webp', 0.82);
      if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      if (dataUrl.length > 2_600_000) dataUrl = canvas.toDataURL('image/jpeg', 0.68);
      return dataUrl;
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  }

  // ── the Settings → General rows ─────────────────────────────────────────

  /**
   * `settings.general.item` is a "row draws its own internals" seat: the owner
   * projects no label and passes no props of its own, and copy / current value /
   * write path belong to us. Two host mechanisms are used exactly as the shipped
   * rows use them: `locale: NS` on the registration (the renderer hands the
   * component a `t`) and the standard `useWorkspaces` prop for the workspace
   * list. The write path is the same localStorage-backed store as the console.
   */
  function createSettingsRow(React) {
    const h = React.createElement;

    return function ChatBackdropSettings(props) {
      // `locale: NS` on the registration is what supplies `t`; the local
      // dictionary keeps the row readable even if that ever stops being handed
      // down — a throwing row would blank the whole slot entry.
      const t = props && typeof props.t === 'function'
        ? props.t
        : (key) => FALLBACK_COPY[key] || key;
      const useWorkspaces = props && typeof props.useWorkspaces === 'function' ? props.useWorkspaces : null;
      const items = useWorkspaces
        ? useWorkspaces((snapshot) => (snapshot && Array.isArray(snapshot.items) ? snapshot.items : undefined))
        : undefined;
      const workspaces = items || [];

      const [scope, setScope] = React.useState(DEFAULT_SCOPE);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [, bump] = React.useState(0);
      const fileRef = React.useRef(null);
      const refresh = () => bump((value) => value + 1);

      // A selected workspace can disappear (deleted) between renders: fall back.
      const scopeIsLive = scope === DEFAULT_SCOPE
        || workspaces.some((item) => item && item.workspaceId === scope);
      const selected = scopeIsLive ? scope : DEFAULT_SCOPE;

      const config = getStore().effectiveFor(selected);
      const overridden = getStore().hasOverride(selected);
      const ownsImage = getStore().owns(selected, 'imageUrl') || getStore().owns(selected, 'imageName');
      const percent = Math.round(Number(config.opacity) * 100);

      const write = (patch, options) => {
        api.update(selected, patch, options);
        refresh();
      };
      const preview = (patch) => write(patch, { persist: false });
      const commitOpacity = (event) => {
        const raw = event && event.target && 'value' in event.target
          ? Number(event.target.value)
          : percent;
        write({ opacity: raw / 100 });
      };

      const onPick = async (event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = ''; // so picking the same file twice fires again
        if (!file) return;
        setBusy(true);
        setError('');
        try {
          const imageUrl = await encodeImage(file);
          write({ imageUrl, imageName: file.name });
        } catch {
          setError(t('failed'));
        } finally {
          setBusy(false);
        }
      };

      const resetImage = () => {
        setError('');
        if (selected === DEFAULT_SCOPE) write({ imageUrl: '', imageName: '' });
        else write({ imageUrl: undefined, imageName: undefined });
      };

      const followDefault = () => {
        setError('');
        api.clearScope(selected);
        refresh();
      };

      const resetAll = () => {
        setError('');
        api.reset();
        refresh();
      };

      const scopeOptions = [{ value: DEFAULT_SCOPE, label: t('scopeDefaultOption') }];
      for (const item of workspaces) {
        if (!item || !item.workspaceId) continue;
        const base = item.title || item.path || item.workspaceId;
        const current = api.scope === item.workspaceId ? t('currentSuffix') : '';
        scopeOptions.push({ value: item.workspaceId, label: `${base}${current}` });
      }

      const inherited = selected !== DEFAULT_SCOPE && !ownsImage;
      const imageSource = config.imageUrl
        ? `${inherited ? t('inheritPrefix') : ''}${t('imageDescCustom')}${config.imageName || t('imageUntitled')}`
        : `${inherited ? t('inheritPrefix') : ''}${t('imageDescBuiltin')}`;
      const scopeDesc = selected === DEFAULT_SCOPE
        ? t('scopeDescDefault')
        : (overridden ? t('scopeDescOverride') : t('scopeDescInherit'));
      const canResetImage = selected === DEFAULT_SCOPE ? Boolean(config.imageUrl) : ownsImage;

      // The swatch previews the SELECTED scope, not the applied one, so it is
      // driven by local custom properties (see .dshx-cb-preview).
      const swatchStyle = {
        '--dshx-cb-local-veil': `${((1 - Math.min(1, Math.max(0, Number(config.opacity) || 0))) * 100).toFixed(1)}%`,
        '--dshx-cb-local-dim': String(Math.min(1, Math.max(0, Number(config.imageDim) || 0))),
        '--dshx-cb-local-image': `url("${config.imageUrl || IMAGE}")`,
      };

      // Three host-shaped rows in one occupant: each draws the host's own row
      // chrome (padding, bottom hairline, title/desc pair), the control area sits
      // on the right.
      return h(React.Fragment, null,
        h('div', { className: 'dshx-cb-row' },
          h('div', { className: 'dshx-cb-text' },
            h('div', { className: 'dshx-cb-title' }, t('scopeTitle')),
            h('div', { className: 'dshx-cb-desc' }, scopeDesc),
          ),
          h('div', { className: 'dshx-cb-actions' },
            h('select', {
              className: 'dshx-cb-select',
              value: selected,
              'aria-label': t('scopeTitle'),
              onChange: (event) => {
                setError('');
                setScope(event.target.value);
              },
            }, scopeOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
          ),
        ),

        h('div', { className: 'dshx-cb-row' },
          h('div', { className: 'dshx-cb-text' },
            h('div', { className: 'dshx-cb-title' }, t('imageTitle')),
            h('div', { className: 'dshx-cb-desc', title: imageSource }, error || imageSource),
          ),
          h('div', { className: 'dshx-cb-actions' },
            h('span', { className: 'dshx-cb-preview', 'aria-hidden': true, style: swatchStyle }),
            h('button', {
              type: 'button',
              className: 'dshx-cb-choose',
              onClick: () => fileRef.current && fileRef.current.click(),
              disabled: busy,
            }, busy ? t('picking') : t('pick')),
            h('button', {
              type: 'button',
              className: 'dshx-cb-reset',
              onClick: resetImage,
              disabled: !canResetImage || busy,
            }, selected === DEFAULT_SCOPE ? t('resetImage') : t('useDefaultImage')),
          ),
        ),

        h('div', { className: 'dshx-cb-row' },
          h('div', { className: 'dshx-cb-text' },
            h('div', { className: 'dshx-cb-title' }, t('opacityTitle')),
            h('div', { className: 'dshx-cb-desc' },
              api.persisted === false ? t('quota') : t('opacityDesc')),
          ),
          h('div', { className: 'dshx-cb-actions' },
            h('input', {
              className: 'dshx-cb-slider',
              type: 'range',
              min: 0,
              max: 100,
              step: 1,
              value: percent,
              'aria-label': t('opacityTitle'),
              onChange: (event) => preview({ opacity: Number(event.target.value) / 100 }),
              onPointerUp: commitOpacity,
              onKeyUp: commitOpacity,
              onBlur: commitOpacity,
            }),
            h('span', { className: 'dshx-cb-value' }, `${percent}%`),
            h('button', {
              type: 'button',
              className: 'dshx-cb-reset',
              onClick: selected === DEFAULT_SCOPE ? resetAll : followDefault,
            }, selected === DEFAULT_SCOPE ? t('resetAll') : t('followDefault')),
          ),
        ),

        h('input', {
          ref: fileRef,
          type: 'file',
          accept: 'image/*',
          style: { display: 'none' },
          onChange: onPick,
        }),
      );
    };
  }

  /** Settings → General rows, right after the other appearance-ish rows. */
  const SETTINGS_SLOT = 'settings.general.item';
  const SETTINGS_ORDER = 13; // language 0 · appearance 10 · font-size 11 · transcript-view 12 · …
  const LOCALE_NS = MODULE_ID;

  window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory: (require) => {
      const module = { exports: {} };
      const React = require('react');
      // `slots` renders the rows, `locale` carries their copy; the wallpaper
      // itself is pure DOM + CSS, and React comes from the browser module table.
      const inject = ['slots', 'locale'];
      function apply(ctx) {
        start(ctx);
        registerProbes(ctx, React);
        ctx.effect(
          () => ctx.locale.register(LOCALE_NS, DICT),
          `${MODULE_ID}: dictionaries`,
        );
        ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register(
          {
            name: SETTINGS_SLOT,
            id: 'chat-backdrop',
            order: SETTINGS_ORDER,
            locale: LOCALE_NS,
          },
          createSettingsRow(React),
        ));
      }
      module.exports.apply = apply;
      module.exports.inject = inject;
      return module.exports;
    },
  });
})();
