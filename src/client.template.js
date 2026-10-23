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
  const IMAGE = '__BACKDROP_DATA_URL__';

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
