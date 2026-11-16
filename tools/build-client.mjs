/**
 * Assemble dist/client.js from src/client.template.js, src/backdrop-store.js and
 * assets/backdrop.webp.
 *
 *   node tools/build-client.mjs
 *
 * Two inlines happen here:
 *  - src/backdrop-store.js is the DOM-free persistence/scope logic. It stays a
 *    normal ESM module so tools/test-store.mjs can import it in Node; the build
 *    strips its `export` keywords and drops it into the template's placeholder,
 *    so the shipped bundle remains a classic script.
 *  - assets/backdrop.webp becomes a data: URL. The page is served from an http
 *    origin, where CSS cannot load a `file:///...` image (mixed scheme), so a
 *    data URL is what keeps the plugin self-contained and offline.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = join(root, 'src', 'client.template.js');
const storePath = join(root, 'src', 'backdrop-store.js');
const assetPath = join(root, 'assets', 'backdrop.webp');
const outPath = join(root, 'dist', 'client.js');

const [template, storeSource, asset] = await Promise.all([
  readFile(templatePath, 'utf8'),
  readFile(storePath, 'utf8'),
  readFile(assetPath),
]);

if (!template.includes('__BACKDROP_DATA_URL__')) {
  throw new Error('src/client.template.js is missing the __BACKDROP_DATA_URL__ placeholder');
}
if (!template.includes('/* __BACKDROP_STORE__ */')) {
  throw new Error('src/client.template.js is missing the __BACKDROP_STORE__ placeholder');
}

// ESM -> plain declarations. Only lines that start with `export ` are rewritten,
// which is all backdrop-store.js uses.
const storeInline = storeSource.replace(/^export\s+/gm, '');
if (/^\s*(import|export)\b/m.test(storeInline)) {
  throw new Error('src/backdrop-store.js must use declarations only (no import/export besides top-level `export `)');
}

const dataUrl = `data:image/webp;base64,${asset.toString('base64')}`;
const out = template
  .replace('/* __BACKDROP_STORE__ */', () => storeInline)
  .replaceAll('__BACKDROP_DATA_URL__', () => dataUrl);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, out);

console.log(`dist/client.js  ${(Buffer.byteLength(out) / 1024).toFixed(1)} KB  `
  + `(asset ${(asset.length / 1024).toFixed(1)} KB, store ${(Buffer.byteLength(storeInline) / 1024).toFixed(1)} KB)`);
