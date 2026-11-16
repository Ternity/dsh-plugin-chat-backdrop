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

  /* __BACKDROP_STORE__ */

  /** Inlined by tools/build-client.mjs from assets/backdrop.webp. */
  const IMAGE = '__BACKDROP_DATA_URL__';

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
