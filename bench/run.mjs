#!/usr/bin/env node
/**
 * Drives bench/page.ts in headless Chromium (Playwright) against a Vite dev server that serves imagefast
 * from ../src. Writes bench/results/<date>.json and prints the markdown tables used in BENCHMARKS.md.
 *
 *   IMAGEFAST_RAW="a.cr2:b.nef" IMAGEFAST_HEIC=x.heic IMAGEFAST_TIFF=y.tiff npm run bench
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = (p) => resolve(root, 'src', p);

// Optional real files, never copied into the repo.
const split = (v) => (v ? v.split(':').filter(Boolean) : []);
const fixtures = [
  ...split(process.env.IMAGEFAST_RAW).map((p) => ({ kind: 'raw', path: p })),
  ...split(process.env.IMAGEFAST_HEIC)
    .slice(0, 1)
    .map((p) => ({ kind: 'heic', path: p })),
  ...split(process.env.IMAGEFAST_TIFF)
    .slice(0, 1)
    .map((p) => ({ kind: 'tiff', path: p })),
].filter((f) => {
  if (existsSync(f.path)) return true;
  console.warn(`skipping missing fixture ${f.path}`);
  return false;
});

const server = await createServer({
  root: here,
  configFile: false,
  logLevel: 'warn',
  resolve: {
    alias: {
      'imagefast/raw': src('raw-plugin.ts'),
      'imagefast/tiff': src('tiff-plugin.ts'),
      'imagefast/psd': src('psd-plugin.ts'),
      'imagefast/heic': src('heic-plugin.ts'),
      imagefast: src('index.ts'),
    },
  },
  server: { port: Number(process.env.IMAGEFAST_BENCH_PORT ?? 4399), strictPort: false, fs: { allow: [root] } },
  worker: { format: 'es' },
  plugins: [
    {
      name: 'fixtures',
      configureServer(s) {
        s.middlewares.use('/fixture/', (req, res) => {
          const f = fixtures[Number(req.url.slice(1))];
          if (!f) return void ((res.statusCode = 404), res.end());
          res.setHeader('content-length', statSync(f.path).size);
          createReadStream(f.path).pipe(res);
        });
      },
    },
  ],
});
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('console', (m) => process.stdout.write(`  [page] ${m.text()}\n`));
page.on('pageerror', (e) => console.error('  [pageerror]', e));
await page.goto(url);
await page.waitForFunction(() => typeof window.runBench === 'function');

const config = {
  // Named by kind and position: the results file is committed, local file names stay out of it.
  fixtures: fixtures.map((f, i) => ({ name: `${f.kind}-${i + 1}${extname(f.path).toLowerCase()}`, kind: f.kind, url: `/fixture/${i}` })),
  thumbFiles: Number(process.env.IMAGEFAST_THUMB_FILES ?? 40),
  thumbWidth: 1024,
  iterations: Number(process.env.IMAGEFAST_ITERATIONS ?? 20),
};
const t0 = Date.now();
const results = await page.evaluate((cfg) => window.runBench(cfg), config);
const wall = Date.now() - t0;
await browser.close();
await server.close();

// Bundle sizes from dist/ (built if missing).
if (!existsSync(join(root, 'dist', 'imagefast.js'))) execSync('npm run build', { cwd: root, stdio: 'inherit' });
const sizeOf = (p) => {
  const b = readFileSync(p);
  return { raw: b.length, gzip: gzipSync(b).length };
};
const dist = join(root, 'dist');
const assets = join(dist, 'assets');
const find = (dir, re) =>
  readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => join(dir, f));
// What actually loads at runtime, per path. Each plugin's decoder module is one file, imported by every worker
// (and by the calling thread with `workers: 0`); libraw.wasm and libheif.js are fetched on the first file that needs them.
const js = (dir, re) => find(dir, re).filter((f) => f.endsWith('.js'));
const sizes = {
  'core: imagefast.js': [join(dist, 'imagefast.js')],
  'core worker (fetched on first call)': js(assets, /^worker-[A-Za-z0-9_-]+\.js$/).filter((f) => !/worker-(raw|tiff|psd|heic)/.test(f)),
  'imagefast/raw decoder module (LibRaw glue)': js(assets, /^worker-raw/),
  'imagefast/raw libraw.wasm (fetched on first RAW)': [join(dist, 'libraw.wasm')],
  'imagefast/tiff decoder module (UTIF + pako)': js(assets, /^worker-tiff/),
  'imagefast/psd decoder module': js(assets, /^worker-psd/),
  'imagefast/heic decoder module': js(assets, /^worker-heic/),
  'imagefast/heic libheif.js (fetched on first HEIC the browser cannot decode)': [join(dist, 'libheif.js')],
};
const bundle = Object.fromEntries(
  Object.entries(sizes).map(([k, files]) => {
    const s = files.map(sizeOf);
    return [k, { files: files.map((f) => basename(f)), raw: s.reduce((n, x) => n + x.raw, 0), gzip: s.reduce((n, x) => n + x.gzip, 0) }];
  }),
);

const machine = {
  date: new Date().toISOString().slice(0, 10),
  cpu: (() => {
    try {
      return execSync('sysctl -n machdep.cpu.brand_string', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      return os.cpus()[0]?.model ?? 'unknown';
    }
  })(),
  cores: os.cpus().length,
  memoryGB: Math.round(os.totalmem() / 2 ** 30),
  os: (() => {
    try {
      return `macOS ${execSync('sw_vers -productVersion', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()}`;
    } catch {
      return `${os.type()} ${os.release()}`;
    }
  })(),
  node: process.version,
  browser: results.userAgent.match(/(HeadlessChrome|Chrome)\/[\d.]+/)?.[0] ?? results.userAgent,
  benchWallMs: wall,
};
const out = { machine, config, bundle, ...results };
mkdirSync(join(here, 'results'), { recursive: true });
const file = join(here, 'results', `${machine.date}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));

const kb = (n) => (n < 1024 ? `${n} B` : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(0)} KB`);
const ms = (n) => (n == null ? 'n/a' : `${n} ms`);
const lines = [];
lines.push(`Machine: ${machine.cpu}, ${machine.cores} cores, ${machine.memoryGB} GB, ${machine.os}; ${machine.browser}; ${machine.date}\n`);
lines.push(
  '### dimensions()\n',
  '| file | size | pool (`fast.dimensions`) | `probeDimensions` on main thread | `createImageBitmap` decode |',
  '|---|---|---|---|---|',
);
for (const r of results.dimensions)
  lines.push(`| ${r.format} | ${(r.bytes / 1e6).toFixed(1)} MB | ${ms(r.poolMs)} (${r.method}) | ${ms(r.probeMs)} | ${ms(r.nativeMs)} |`);
lines.push(
  '',
  `### thumbnail() — ${results.thumbnails.files} × 4000×3000 JPEG (${(results.thumbnails.totalBytes / 1e6).toFixed(0)} MB) → ${results.thumbnails.width} px\n`,
);
lines.push('| approach | total wall | per-file median | longest frame gap | frames > 50 ms | long tasks |', '|---|---|---|---|---|---|');
for (const [k, v] of Object.entries(results.thumbnails.results))
  lines.push(
    `| ${k}${v.workers ? ` (${v.workers} workers)` : ''} | ${ms(v.ms)} | ${ms(v.perFileMedian)} | ${ms(v.maxGap)} | ${v.longFrames} | ${ms(v.longTaskMs)} |`,
  );
lines.push(
  '',
  '### plugin decoders — thumbnail(width: 1024), 1 worker\n',
  '| file | size | source | decoded by | cold (first call) | warm median |',
  '|---|---|---|---|---|---|',
);
for (const r of results.plugins)
  lines.push(`| ${r.format} | ${(r.bytes / 1e6).toFixed(1)} MB | ${r.source} | ${r.decodedBy} | ${ms(r.coldMs)} | ${ms(r.warmMs)} |`);
if (results.raw) {
  lines.push(
    '',
    '### RAW (imagefast/raw, LibRaw wasm), 1 worker\n',
    '| camera | size | image | cold (incl. wasm load) | dimensions | decodeRaw 1024 (embedded) | forced demosaic | thumbnail 1024 |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const r of results.raw.rows)
    lines.push(
      `| ${r.camera} | ${(r.bytes / 1e6).toFixed(1)} MB | ${r.width}×${r.height} | ${ms(r.coldMs)} | ${ms(r.dimensionsMs)} | ${ms(r.embeddedMs)} (${r.embeddedMethod} ${r.embeddedPreview}) | ${ms(r.demosaicMs)} (${r.demosaicMethod} ${r.demosaicSize}) | ${ms(r.thumbnailMs)} |`,
    );
  const p = results.raw.parallel;
  lines.push(
    '',
    `All ${p.files} files at once on a fresh pool (LibRaw loading cold in every worker): ${ms(p.ms)} for ${(p.totalBytes / 1e6).toFixed(0)} MB, longest main-thread frame gap ${ms(p.maxGap)}.`,
  );
}
lines.push('', '### bundle size (dist/, Vite lib build)\n', '| what | files | raw | gzip |', '|---|---|---|---|');
for (const [k, v] of Object.entries(bundle)) lines.push(`| ${k} | ${v.files.length} | ${kb(v.raw)} | ${kb(v.gzip)} |`);
const md = lines.join('\n');
console.log('\n' + md);
writeFileSync(join(here, 'results', `${machine.date}.md`), md + '\n');
console.log(`\nwrote ${file}`);
