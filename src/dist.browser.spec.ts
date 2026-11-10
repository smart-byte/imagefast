import { describe, expect, it } from 'vitest';
import { psdFile } from './test/fixtures';

/**
 * Smoke test against the built package, served untransformed (`publicDir: 'dist'` in vitest.config.ts, so run
 * `npm run build` first). Everything else runs the sources through Vite, which hides bundling bugs such as empty
 * plugin worker chunks.
 */
async function dist(file: string) {
  const url = new URL(`/${file}`, location.href).href;
  if (!(await fetch(url, { method: 'HEAD' })).ok) throw new Error(`${url} not served: run \`npm run build\` before the browser tests`);
  return import(/* @vite-ignore */ url);
}

describe('dist/', () => {
  it('decodes through a plugin inside the worker', async () => {
    const { createImageFast } = await dist('imagefast.js');
    const { psd } = await dist('psd.js');
    const fast = createImageFast({ plugins: [psd] });
    try {
      expect(await fast.thumbnail(psdFile(), { width: 2 })).toMatchObject({ width: 2, height: 2, decodedBy: 'psd' });
    } finally {
      fast.terminate();
    }
  });
});
