import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

// Self-hosted, cookieless Umami, exactly as privacy.html describes it: it counts only on imagefast.dev, honours
// Do Not Track and drops query strings and fragments. Without a website ID no page gets the script.
const UMAMI_WEBSITE_ID = '4d11104b-5074-4d98-b960-13fa2d638ac4';
const umami = {
  defer: true,
  src: 'https://analytics.smart-byte.com/script.js',
  'data-website-id': UMAMI_WEBSITE_ID,
  'data-domains': 'imagefast.dev',
  'data-do-not-track': 'true',
  'data-exclude-search': 'true',
  'data-exclude-hash': 'true',
};

export default defineConfig({
  root: page('.'),
  base: './',
  server: {
    port: 4340,
    host: '127.0.0.1',
    fs: { allow: [page('..')] },
  },
  plugins: [{ name: 'umami', transformIndexHtml: () => (UMAMI_WEBSITE_ID ? [{ tag: 'script', attrs: umami, injectTo: 'head' }] : []) }],
  build: {
    outDir: '../site-dist',
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: { input: ['index.html', 'privacy.html', 'legal-notice.html'].map(page) },
  },
  worker: {
    format: 'es',
    // Decoder entries are imported as modules by the pool worker. Keep their exports;
    // Vite's default worker build treats entries as standalone scripts.
    plugins: () => [{ name: 'preserve-decoder-exports', options: (options) => ({ ...options, preserveEntrySignatures: 'strict' }) }],
  },
});
