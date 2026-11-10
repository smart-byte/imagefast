# imagefast benchmarks

Headless-Chromium benchmark harness. Results and methodology: [`../BENCHMARKS.md`](../BENCHMARKS.md).

```bash
cd bench && npm install        # playwright + browser-image-compression, kept out of the library's own devDeps
npx playwright install chromium
cd .. && npm run bench         # writes bench/results/<date>.json and prints markdown tables
```

Optional real files (skipped when absent):

- `IMAGEFAST_RAW="a.cr2:b.nef:..."` — RAW files for the LibRaw section (camera model is read from the file).
- `IMAGEFAST_HEIC=path.heic`, `IMAGEFAST_TIFF=path.tiff` — header-probe + thumbnail rows for those formats.

Everything else (JPEG/PNG/WebP/PSD) is generated in the browser at run time.
