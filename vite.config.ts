import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/**
 * Files the plugins fetch lazily at runtime: `src/*-plugin.ts` -> `new URL(<key>, import.meta.url)` -> copy in dist/.
 * Library mode would inline them into the entry as base64, so the reference is pointed at a plain copy next to the
 * entries instead; the consumer's bundler then emits that copy like any other `new URL(..., import.meta.url)` asset.
 */
const RUNTIME_FILES: Record<string, string> = {
  './libraw.wasm': 'libraw.wasm',
  '../node_modules/libheif-js/libheif-wasm/libheif-bundle.mjs': 'libheif.js',
};

/** Copied into dist/ as they are: the licences that travel with the bundled libraries, and the types `rawdecode.d.ts` imports. */
const COPIED_FILES: Record<string, string> = {
  '../node_modules/libheif-js/libheif-wasm/LICENSE': 'libheif.LICENSE.txt',
  '../wasm/libraw/LICENSE.txt': 'libraw.LICENSE.txt',
  '../node_modules/utif/LICENSE': 'utif.LICENSE.txt',
  '../node_modules/pako/LICENSE': 'pako.LICENSE.txt',
  './libraw.d.ts': 'libraw.d.ts',
};

const runtimeFiles: Plugin = {
  name: 'imagefast:runtime-files',
  apply: 'build', // the dev server (tests, site) serves the referenced files as they are
  enforce: 'pre',
  transform(code) {
    let out = code;
    for (const [from, to] of Object.entries(RUNTIME_FILES)) {
      out = out.replaceAll(`new URL('${from}', import.meta.url)`, `new URL(/* @vite-ignore */ './${to}', import.meta.url)`);
    }
    return out === code ? null : { code: out, map: null };
  },
  // Rollup keeps the comment; the consumer's bundler must not skip the reference.
  renderChunk(code) {
    const out = code.replace(/\/\* @vite-ignore \*\/\s*(?="\.\/[^"]+",\s*import\.meta\.url)/g, '');
    return out === code ? null : { code: out, map: null };
  },
  generateBundle() {
    for (const [from, to] of Object.entries({ ...RUNTIME_FILES, ...COPIED_FILES })) {
      this.emitFile({ type: 'asset', fileName: to, source: readFileSync(new URL(from, new URL('./src/', import.meta.url))) });
    }
  },
};

export default defineConfig({
  plugins: [runtimeFiles],
  build: {
    // ES2022 runs in Chrome 94, Firefox 93 and Safari 16.4, all at or below the documented floor (README, Browser
    // support). An older target lowers optional chaining and class fields through helpers: +8% for browsers from 2020.
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: {
        imagefast: 'src/index.ts',
        raw: 'src/raw-plugin.ts',
        tiff: 'src/tiff-plugin.ts',
        psd: 'src/psd-plugin.ts',
        heic: 'src/heic-plugin.ts',
      },
      formats: ['es'],
    },
  },
  worker: {
    format: 'es',
    // The plugin decoder modules (`?worker&url`) are `import()`ed by the pool worker, so their exports must
    // survive. Vite hardcodes `preserveEntrySignatures: false` for worker bundles (it assumes standalone
    // scripts) and emits empty chunks; a plugin's `options` hook runs after that and wins.
    plugins: () => [{ name: 'keep-worker-exports', options: (o) => ({ ...o, preserveEntrySignatures: 'strict' }) }],
  },
  experimental: {
    // Library builds must reference emitted worker files relative to the importing module, not to `base`.
    renderBuiltUrl(filename, { hostType }) {
      return hostType === 'js' ? { runtime: `new URL(${JSON.stringify(filename)}, import.meta.url).href` } : { relative: true };
    },
  },
});
