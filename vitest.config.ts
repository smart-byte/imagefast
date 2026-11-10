import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'unit', include: ['src/**/*.spec.ts'], exclude: ['src/**/*.browser.spec.ts'] },
      },
      {
        // Real workers, createImageBitmap and OffscreenCanvas in headless Chromium. Fixtures are generated in the page.
        worker: { format: 'es' },
        // Serves the built package untransformed at `/imagefast.js` etc. for dist.browser.spec.ts (run `npm run build` first).
        publicDir: 'dist',
        test: {
          name: 'browser',
          include: ['src/**/*.browser.spec.ts'],
          browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: 'chromium' }], screenshotFailures: false },
        },
      },
    ],
  },
});
