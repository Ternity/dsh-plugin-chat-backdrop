/**
 * Pure host half.
 *
 * The whole feature lives in the browser half (`exports["./client"]` ->
 * `dist/client.js`), which the host serves to the renderer. All this module has
 * to do is exist, so the loader row can mount the package and the
 * `dsh.client` discovery in `package.json` can find the browser export.
 *
 * Modelled on the shipped `@deepseek-ai/dsh-client-resources`, whose host half
 * is exactly this shape.
 */

function apply() {}

export { apply };
