import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  server: {
    port: 4340,
    host: '127.0.0.1',
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  build: { outDir: '../site-dist', emptyOutDir: true, target: 'es2022' },
  worker: {
    format: 'es',
    // Decoder entries are imported as modules by the pool worker. Keep their exports;
    // Vite's default worker build treats entries as standalone scripts.
    plugins: () => [{ name: 'preserve-decoder-exports', options: (options) => ({ ...options, preserveEntrySignatures: 'strict' }) }],
  },
});
