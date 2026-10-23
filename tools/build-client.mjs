/**
 * Assemble dist/client.js from src/client.template.js plus assets/backdrop.webp.
 *
 *   node tools/build-client.mjs
 *
 * Why inline the picture: the page is served over http://127.0.0.1:<port>, so a
 * `file:///C:/...` URL in CSS is blocked by Chromium (mixed scheme, no file
 * access from the http origin). A data: URL keeps the plugin self-contained and
 * offline. The webp asset is ~13 KB, so the base64 payload is ~18 KB — cheap
 * enough to ship inside the module the host already serves.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = join(root, 'src', 'client.template.js');
const assetPath = join(root, 'assets', 'backdrop.webp');
const outPath = join(root, 'dist', 'client.js');

const template = await readFile(templatePath, 'utf8');
const asset = await readFile(assetPath);
const dataUrl = `data:image/webp;base64,${asset.toString('base64')}`;

if (!template.includes('__BACKDROP_DATA_URL__')) {
  throw new Error('src/client.template.js is missing the __BACKDROP_DATA_URL__ placeholder');
}

const out = template.replaceAll('__BACKDROP_DATA_URL__', dataUrl);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, out);

console.log(`dist/client.js  ${(Buffer.byteLength(out) / 1024).toFixed(1)} KB  `
  + `(asset ${(asset.length / 1024).toFixed(1)} KB)`);
