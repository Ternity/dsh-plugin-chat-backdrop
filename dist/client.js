'use strict';

/*
 * dsh-plugin-chat-backdrop — browser half.
 *
 * Registers a lazy CJS factory through the client module loader, the same path
 * the shipped `@deepseek-ai/dsh-client-*` packages and third-party plugins such
 * as `ds-harness-remote` use. `id` must equal the package name.
 *
 * What it does: paints a wallpaper behind the conversation column and makes the
 * surfaces on top of it translucent, so the photo shows through while the
 * theme's own colours keep the text readable.
 *
 * How, and why this way
 * ---------------------
 * A first version walked the DOM and rewrote `background-color` on every big
 * surface. Reading the shipped client CSS showed a far better seam: the areas
 * that matter each paint themselves from ONE theme token, and those tokens can
 * be rebound on a subtree:
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
 * The rebinding has two rules that must be respected, both learned the hard way:
 *   1. never define a variable in terms of itself on the same element (that is a
 *      cycle and the whole declaration is dropped), so derived colours are
 *      computed on <body> under fresh `--dshx-cb-*` names and only then assigned
 *      to the official name deeper down;
 *   2. never touch the `--dsw-alias-*` tokens on <body> itself — the theme
 *      presenter writes them as inline styles, so a stylesheet cannot win, and
 *      they are shared with modals, menus and tooltips.
 *
 * Play with it from the renderer console (values persist to localStorage):
 *
 *   __DSH_CHAT_BACKDROP__.setConfig({ opacity: 0.85 })   // 0 = photo only
 *   __DSH_CHAT_BACKDROP__.config                          // current values
 *   __DSH_CHAT_BACKDROP__.reset()
 */

(() => {
  const MODULE_ID = 'dsh-plugin-chat-backdrop';
  const STYLE_ID = 'dsh-chat-backdrop-style';
  const STORAGE_KEY = 'dsh.chatBackdrop';

  /** Inlined by tools/build-client.mjs from assets/backdrop.webp. */
  const IMAGE = 'data:image/webp;base64,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';

  /**
   * Everything the Settings → General row can change lives here, and every value
   * can also be set from the renderer console through the
   * `window.__DSH_CHAT_BACKDROP__` handle. Values are persisted to localStorage
   * under `dsh.chatBackdrop`; a custom picture rides along as a data URL, which
   * is why the row downscales a picked file before storing it.
   */
  const DEFAULTS = {
    /**
     * How strongly the photo shows through: 0 = only the theme surface (no
     * wallpaper), 1 = photo with no wash at all. The slider in Settings →
     * General drives exactly this value; the veil painted over the photo is
     * `1 - opacity`.
     */
    opacity: 0.62,
    /** Custom picture picked in Settings → General, as a data URL. Empty = built-in. */
    imageUrl: '',
    /** Display name of the picked file (cosmetic only). */
    imageName: '',
    /** Extra black wash over the photo, 0..1 (bright photos only). */
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
       Three layers: themed veil, optional black wash, then the photo.
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
    /* The swatch paints exactly the same three layers as the wallpaper, from the
       same variables, so it tracks the slider without any extra plumbing. */
    .dshx-cb-preview {
      flex: 0 0 auto; width: 64px; height: 36px;
      border-radius: var(--dsw-radius-md);
      border: 0.5px solid var(--dsw-alias-border-l2);
      background-image:
        linear-gradient(var(--dshx-cb-surface), var(--dshx-cb-surface)),
        linear-gradient(rgba(0, 0, 0, var(--dshx-cb-dim)), rgba(0, 0, 0, var(--dshx-cb-dim))),
        var(--dshx-cb-image);
      background-size: auto, auto, cover;
      background-position: center, center, center;
      background-repeat: no-repeat, no-repeat, no-repeat;
    }
  `;

  function readOverride() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) || {} : {};
    } catch {
      return {};
    }
  }

  function currentConfig() {
    const override = readOverride();
    const config = { ...DEFAULTS };
    for (const [key, value] of Object.entries(override)) {
      if (key in DEFAULTS) config[key] = value;
    }
    return config;
  }

  /** Returns false when the value could not be persisted (quota / private mode). */
  function writeOverride(config) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      return true;
    } catch {
      // A picked picture can push the JSON past the origin quota: the look still
      // applies for this page, and the settings row says so.
      return false;
    }
  }

  /**
   * Deferred writes.
   *
   * Dragging the opacity slider fires an input event per pixel, and the config
   * carries the picked picture as a data URL, so persisting every tick would
   * re-serialize hundreds of KB dozens of times a second. Continuous updates
   * therefore apply to the DOM immediately and only the last one is written,
   * 350 ms after the drag stops (or on release / unmount).
   */
  let persistTimer = 0;
  let pendingConfig = null;

  function flushPersist() {
    if (persistTimer) {
      window.clearTimeout(persistTimer);
      persistTimer = 0;
    }
    if (pendingConfig) {
      api.persisted = writeOverride(pendingConfig);
      pendingConfig = null;
    }
  }

  function schedulePersist(config) {
    pendingConfig = config;
    if (persistTimer) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      persistTimer = 0;
      flushPersist();
    }, 350);
  }

  function applyConfig(config) {
    const root = document.documentElement;
    const set = (name, value) => root.style.setProperty(name, value);
    const percent = (value) => `${(Math.min(1, Math.max(0, Number(value) || 0)) * 100).toFixed(1)}%`;
    // A picture picked in Settings → General wins over the built-in one.
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

  /** Console handle: read, tweak and reset the look without a reload. */
  const api = {
    active: true,
    /** false once a write failed (private mode, or an image past the quota). */
    persisted: true,
    get config() {
      return currentConfig();
    },
    /**
     * Apply a patch and persist it. `{ persist: false }` keeps the change live
     * but defers the write (coalesced) — used while a slider is being dragged.
     */
    setConfig(patch, options) {
      const next = { ...currentConfig(), ...patch };
      if (options && options.persist === false) schedulePersist(next);
      else {
        pendingConfig = null;
        api.persisted = writeOverride(next);
      }
      applyConfig(next);
      return next;
    },
    reset() {
      if (persistTimer) {
        window.clearTimeout(persistTimer);
        persistTimer = 0;
      }
      pendingConfig = null;
      try {
        window.localStorage.removeItem(STORAGE_KEY);
        api.persisted = true;
      } catch {
        api.persisted = false;
      }
      const next = currentConfig();
      applyConfig(next);
      return next;
    },
  };

  function start(ctx) {
    // Everything is registered as an effect, so cordis tears it all down when
    // the plugin is disabled, reloaded (HMR) or removed.
    ctx.effect(() => installStyle(), `${MODULE_ID}: backdrop stylesheet`);
    ctx.effect(() => {
      applyConfig(currentConfig());
      return () => {
        flushPersist();
        clearConfig();
      };
    }, `${MODULE_ID}: backdrop variables`);
    ctx.effect(() => {
      window.__DSH_CHAT_BACKDROP__ = api;
      return () => { delete window.__DSH_CHAT_BACKDROP__; };
    }, `${MODULE_ID}: console handle`);
  }

  /**
   * Zero-space occupant of an existing list slot, rendering nothing.
   *
   * It exists so the browser half is observable from outside the page: the
   * official client-plugin verification is "the live Client slot", i.e.
   *
   *   cordis_inspect_query platform=client provider=Slots method=listSubTree
   *                      input={"root":"conversation.composer.dock"}
   *
   * will list an occupant with id `chat-backdrop` exactly when this bundle
   * materialized in the running page. The real user-facing control lives in
   * Settings → General; this seat is purely the observable side of that.
   */
  function BackdropProbe() {
    return null;
  }

  const PROBE_SLOT = 'conversation.composer.dock';

  /**
   * One-line report on what the wallpaper actually resolved to in this page,
   * encoded into the probe's slot id so it can be read from OUTSIDE the page:
   *
   *   chat-backdrop-diag-s<a>a<b>i<c>v<d>h<e>c<f>o<g>u<h>-<theme>-<has>
   *
   *   s  the injected <style data-plugin="…"> tag is in the document
   *   a  <html data-dsh-chat-backdrop="1"> is set
   *   i  --dshx-cb-image resolves to something on <html>
   *   v  --dshx-cb-surface resolves to something on <body>
   *   h  [data-conversation-content] computes a background-image with the photo
   *   c  composer card alpha x100 (0-99 = translucent, 100 = opaque, x = no card)
   *   o  configured opacity x100 (what the Settings slider writes)
   *   u  1 when a picture picked in Settings → General is in use
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
    const host = document.querySelector('[data-conversation-content]');
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
    const config = currentConfig();
    const opacity = String(Math.round(Number(config.opacity) * 100));
    const custom = bit(Boolean(config.imageUrl));
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
      + `-${theme}-${supportsHas ? 'has' : 'nohas'}`;
  }

  function registerProbes(ctx) {
    const register = (id) => ctx.slots.inject(PROBE_SLOT, () => ctx.slots.register(
      { name: PROBE_SLOT, id, order: 100 },
      BackdropProbe,
    ));
    register('chat-backdrop');
    ctx.effect(() => {
      let dispose;
      const timer = window.setTimeout(() => {
        dispose = register(`chat-backdrop-diag-${diagnose()}`);
      }, 3000);
      return () => {
        window.clearTimeout(timer);
        if (typeof dispose === 'function') dispose();
      };
    }, `${MODULE_ID}: diagnostics probe`);
  }

  /* ── the Settings → General rows ─────────────────────────────────────────────
   * `settings.general.item` is a "row draws its own internals" seat: the owner
   * projects no label and passes no props of its own (the catalog says so in as
   * many words), and copy / current value / write path belong to us.
   *
   * Two host mechanisms are used exactly as the shipped rows use them:
   *   - `locale: NS` on the registration, so the renderer hands the component a
   *     `t` bound to this plugin's dictionary (ui-conversation's Composer Enter
   *     row does the same), and
   *   - `inject: () => ({...})` for owner-supplied props — unused here, since the
   *     plugin owns its value.
   * The write path is `api.setConfig`, i.e. the same localStorage-backed config
   * the console handle uses.
   */

  const LANG = String(document.documentElement.lang || navigator.language || 'zh').toLowerCase();
  const DICT = {
    zh: {
      imageTitle: '对话背景图',
      imageDescBuiltin: '内置图：雾中图书馆 · 可选一张你自己的图片',
      imageDescCustom: '本地图片：',
      pick: '选择图片…',
      picking: '读取中…',
      resetImage: '恢复默认图',
      opacityTitle: '背景图透明度',
      opacityDesc: '0% 只有主题底色，100% 图片最清楚',
      resetAll: '全部恢复默认',
      failed: '这张图片读不出来',
      quota: '图片太大，只能在本次会话生效（未能持久化）',
    },
    en: {
      imageTitle: 'Chat backdrop image',
      imageDescBuiltin: 'Built-in: foggy library · or pick a picture of your own',
      imageDescCustom: 'Local picture: ',
      pick: 'Choose image…',
      picking: 'Reading…',
      resetImage: 'Use built-in',
      opacityTitle: 'Backdrop opacity',
      opacityDesc: '0% keeps only the theme colour, 100% shows the picture fully',
      resetAll: 'Reset all',
      failed: 'This picture could not be read',
      quota: 'Picture too large to persist — applies to this session only',
    },
  };
  /** Used until (or in case) the locale service hands the component a `t`. */
  const FALLBACK_COPY = LANG.startsWith('zh') ? DICT.zh : DICT.en;

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

  function createSettingsRow(React) {
    const h = React.createElement;

    return function ChatBackdropSettings(props) {
      // `locale: NS` on the registration is what supplies `t`; the local
      // dictionary keeps the row readable even if that ever stops being handed
      // down — a throwing row would blank the whole slot entry.
      const t = props && typeof props.t === 'function'
        ? props.t
        : (key) => FALLBACK_COPY[key] || key;
      const [config, setLocal] = React.useState(() => api.config);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const fileRef = React.useRef(null);

      const patch = (next) => setLocal(api.setConfig(next));
      // Slider drags: live on every tick, written once the drag settles.
      const preview = (next) => setLocal(api.setConfig(next, { persist: false }));
      const commitOpacity = (event) => {
        const raw = event && event.target && 'value' in event.target
          ? Number(event.target.value)
          : Math.round(Number(config.opacity) * 100);
        patch({ opacity: raw / 100 });
      };

      const onPick = async (event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = ''; // so picking the same file twice fires again
        if (!file) return;
        setBusy(true);
        setError('');
        try {
          const imageUrl = await encodeImage(file);
          patch({ imageUrl, imageName: file.name });
        } catch {
          setError(t('failed'));
        } finally {
          setBusy(false);
        }
      };

      const hint = error
        ? error
        : config.imageUrl
          ? `${t('imageDescCustom')}${config.imageName || 'image'}`
          : t('imageDescBuiltin');

      const percent = Math.round(Number(config.opacity) * 100);

      // Two host-shaped rows in one occupant: each draws the host's own row
      // chrome (padding, bottom hairline, title/desc pair), the control area sits
      // on the right.
      return h(React.Fragment, null,
        h('div', { className: 'dshx-cb-row' },
          h('div', { className: 'dshx-cb-text' },
            h('div', { className: 'dshx-cb-title' }, t('imageTitle')),
            h('div', { className: 'dshx-cb-desc', title: hint }, hint),
          ),
          h('div', { className: 'dshx-cb-actions' },
            h('span', { className: 'dshx-cb-preview', 'aria-hidden': true }),
            h('button', {
              type: 'button',
              className: 'dshx-cb-choose',
              onClick: () => fileRef.current && fileRef.current.click(),
              disabled: busy,
            }, busy ? t('picking') : t('pick')),
            h('button', {
              type: 'button',
              className: 'dshx-cb-reset',
              onClick: () => { setError(''); patch({ imageUrl: '', imageName: '' }); },
              disabled: !config.imageUrl || busy,
            }, t('resetImage')),
          ),
        ),
        h('div', { className: 'dshx-cb-row' },
          h('div', { className: 'dshx-cb-text' },
            h('div', { className: 'dshx-cb-title' }, t('opacityTitle')),
            h('div', { className: 'dshx-cb-desc' }, api.persisted === false ? t('quota') : t('opacityDesc')),
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
              onClick: () => { setError(''); setLocal(api.reset()); },
            }, t('resetAll')),
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
      // `slots` renders the row, `locale` carries the row's copy; the wallpaper
      // itself is pure DOM + CSS, and React comes from the browser module table.
      const inject = ['slots', 'locale'];
      function apply(ctx) {
        start(ctx);
        registerProbes(ctx);
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
