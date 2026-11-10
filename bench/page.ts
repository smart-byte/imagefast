/**
 * Browser side of the benchmark. run.mjs drives `window.runBench(config)` in headless Chromium and collects
 * the returned JSON. Everything measured here is wall-clock `performance.now()` around the public API.
 */
import { createImageFast, probeDimensions, type ImageFast } from 'imagefast';
import { raw } from 'imagefast/raw';
import { tiff } from 'imagefast/tiff';
import { psd } from 'imagefast/psd';
import { heic } from 'imagefast/heic';
import imageCompression from 'browser-image-compression';

interface Fixture {
  name: string;
  kind: 'raw' | 'heic' | 'tiff';
  url: string;
}

interface Config {
  fixtures: Fixture[];
  thumbFiles: number;
  thumbWidth: number;
  iterations: number;
}

const log = (s: string) => {
  document.getElementById('log')!.textContent += `\n${s}`;
  console.log(s);
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const round = (n: number) => Math.round(n * 10) / 10;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

async function repeat(n: number, fn: () => Promise<unknown>): Promise<{ median: number; first: number; all: number[] }> {
  const all: number[] = [];
  for (let i = 0; i < n; i++) all.push((await timed(fn)).ms);
  return { median: round(median(all)), first: round(all[0]!), all: all.map(round) };
}

/** Frame-gap + long-task monitor: how badly is the main thread blocked while `fn` runs? */
async function monitored<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T; maxGap: number; longFrames: number; frames: number; longTaskMs: number }> {
  let last = performance.now();
  let maxGap = 0;
  let longFrames = 0;
  let frames = 0;
  let running = true;
  const loop = () => {
    const now = performance.now();
    const gap = now - last;
    last = now;
    frames++;
    if (gap > maxGap) maxGap = gap;
    if (gap > 50) longFrames++;
    if (running) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  let longTaskMs = 0;
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTaskMs += e.duration;
    });
    observer.observe({ type: 'longtask', buffered: false });
  } catch {
    /* longtask unsupported */
  }
  await new Promise((r) => requestAnimationFrame(r));
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  running = false;
  await new Promise((r) => setTimeout(r, 50));
  observer?.disconnect();
  return { ms: round(ms), value, maxGap: round(maxGap), longFrames, frames, longTaskMs: round(longTaskMs) };
}

/** Photo-like noise + gradients so JPEG decode/encode is real work, not a flat fill. */
async function synth(w: number, h: number, type: 'image/jpeg' | 'image/png' | 'image/webp', seed: number): Promise<File> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${(seed * 37) % 360} 70% 55%)`);
  g.addColorStop(1, `hsl(${(seed * 37 + 120) % 360} 70% 25%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let k = 0; k < 12; k++) {
    ctx.fillStyle = `hsl(${(seed * 37 + k * 30) % 360} 80% 60% / 0.4)`;
    ctx.beginPath();
    ctx.arc((seed * 7919 + k * 104729) % w, (seed * 7907 + k * 1299709) % h, (0.05 + (k % 5) * 0.06) * Math.min(w, h), 0, Math.PI * 2);
    ctx.fill();
  }
  // grain: a noise tile drawn repeatedly (cheap to build, expensive enough to encode)
  const tile = new OffscreenCanvas(256, 256);
  const tctx = tile.getContext('2d')!;
  const img = tctx.createImageData(256, 256);
  let x = seed * 2654435761 + 1;
  for (let i = 0; i < img.data.length; i += 4) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const v = (x >> 8) & 0xff;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 40;
  }
  tctx.putImageData(img, 0, 0);
  ctx.fillStyle = ctx.createPattern(tile, 'repeat')!;
  ctx.fillRect(0, 0, w, h);
  const blob = await canvas.convertToBlob(type === 'image/png' ? { type } : { type, quality: 0.92 });
  const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/png' ? 'png' : 'webp';
  return new File([blob], `synth-${seed}.${ext}`, { type });
}

/** Uncompressed 8-bit RGB PSD with a flattened composite (what "Maximize compatibility" writes). */
function synthPsd(w: number, h: number): File {
  const u16 = (n: number) => [n >> 8, n & 0xff];
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const header = new Uint8Array([
    0x38,
    0x42,
    0x50,
    0x53,
    ...u16(1),
    0,
    0,
    0,
    0,
    0,
    0,
    ...u16(3),
    ...u32(h),
    ...u32(w),
    ...u16(8),
    ...u16(3),
    ...u32(0),
    ...u32(0),
    ...u32(0),
    ...u16(0),
  ]);
  const planes = new Uint8Array(w * h * 3);
  let x = 42;
  for (let i = 0; i < planes.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    planes[i] = ((i / w) % 256) ^ ((x >> 16) & 0x1f);
  }
  return new File([header, planes], `synth-${w}x${h}.psd`, { type: 'image/vnd.adobe.photoshop' });
}

async function fetchFile(f: Fixture): Promise<File> {
  const r = await fetch(f.url);
  if (!r.ok) throw new Error(`fixture ${f.name}: ${r.status}`);
  const ext = f.name.split('.').pop()!.toLowerCase();
  const type = f.kind === 'heic' ? 'image/heic' : f.kind === 'tiff' ? 'image/tiff' : '';
  return new File([await r.blob()], f.name, { type: type || `image/x-${ext}` });
}

async function head(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
}

/** Typical hand-rolled approach: <img> + document canvas + toBlob, all on the main thread. */
async function naiveThumb(file: File, width: number): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('img decode failed'));
      i.src = url;
    });
    const w = Math.min(width, img.naturalWidth);
    const h = Math.round((img.naturalHeight / img.naturalWidth) * w);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.8));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function benchDimensions(cfg: Config, real: Record<string, File>) {
  const files: { format: string; file: File }[] = [
    { format: 'JPEG 4000×3000', file: await synth(4000, 3000, 'image/jpeg', 1) },
    { format: 'PNG 4000×3000', file: await synth(4000, 3000, 'image/png', 2) },
    { format: 'WebP 4000×3000', file: await synth(4000, 3000, 'image/webp', 3) },
    { format: 'PSD 4000×3000 (raw RGB)', file: synthPsd(4000, 3000) },
  ];
  if (real.tiff) files.push({ format: `TIFF (${(real.tiff.size / 1e6).toFixed(1)} MB)`, file: real.tiff });
  if (real.heic) files.push({ format: `HEIC (${(real.heic.size / 1e6).toFixed(1)} MB)`, file: real.heic });
  const fast = createImageFast({ plugins: [tiff, psd, heic] });
  const rows = [];
  for (const { format, file } of files) {
    await fast.dimensions(file); // warm the pool
    const pool = await repeat(cfg.iterations, () => fast.dimensions(file));
    const probe = await repeat(cfg.iterations, async () => probeDimensions(await head(file)));
    let native: { median: number } | null = null;
    try {
      await createImageBitmap(file).then((b) => b.close());
      native = await repeat(cfg.iterations, () => createImageBitmap(file).then((b) => b.close()));
    } catch {
      native = null;
    }
    const dims = await fast.dimensions(file);
    rows.push({
      format,
      bytes: file.size,
      width: dims.width,
      height: dims.height,
      method: dims.method,
      poolMs: pool.median,
      probeMs: probe.median,
      nativeMs: native?.median ?? null,
    });
    log(`dims ${format}: pool ${pool.median} ms, probe ${probe.median} ms, native ${native?.median ?? 'n/a'} ms (${dims.method})`);
  }
  fast.terminate();
  return rows;
}

async function benchThumbnails(cfg: Config) {
  const files: File[] = [];
  for (let i = 0; i < cfg.thumbFiles; i++) files.push(await synth(4000, 3000, 'image/jpeg', 100 + i));
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  log(`thumbnail set: ${files.length} JPEGs, ${(totalBytes / 1e6).toFixed(1)} MB`);
  const opts = { width: cfg.thumbWidth, quality: 0.8, type: 'image/jpeg' as const };
  const perFile = (fn: (f: File) => Promise<unknown>) => async () => {
    const times: number[] = [];
    await Promise.all(files.map(async (f) => times.push((await timed(() => fn(f))).ms)));
    return times;
  };
  const results: Record<string, unknown> = {};

  const pool = createImageFast();
  await pool.thumbnail(files[0]!, opts); // warm-up spawns the first worker; the rest spawn during the batch
  const r1 = await monitored(perFile((f) => pool.thumbnail(f, opts)));
  results['imagefast (worker pool)'] = { ...r1, value: undefined, perFileMedian: round(median(r1.value)), workers: pool.stats().size };
  pool.terminate();

  const main = createImageFast({ workers: 0 });
  await main.thumbnail(files[0]!, opts);
  const r2 = await monitored(perFile((f) => main.thumbnail(f, opts)));
  results['imagefast (workers: 0, main thread)'] = { ...r2, value: undefined, perFileMedian: round(median(r2.value)) };

  await naiveThumb(files[0]!, cfg.thumbWidth);
  const r3 = await monitored(perFile((f) => naiveThumb(f, cfg.thumbWidth)));
  results['<img> + canvas.toBlob (main thread)'] = { ...r3, value: undefined, perFileMedian: round(median(r3.value)) };

  const bic = (f: File) =>
    imageCompression(f, { maxWidthOrHeight: cfg.thumbWidth, maxSizeMB: 100, initialQuality: 0.8, fileType: 'image/jpeg', useWebWorker: true });
  await bic(files[0]!);
  const r4 = await monitored(perFile(bic));
  results['browser-image-compression (useWebWorker)'] = { ...r4, value: undefined, perFileMedian: round(median(r4.value)) };

  for (const [k, v] of Object.entries(results)) log(`thumb ${k}: ${JSON.stringify(v)}`);
  return { files: files.length, totalBytes, width: cfg.thumbWidth, results };
}

async function benchRaw(cfg: Config, raws: File[]) {
  if (!raws.length) return null;
  const rows = [];
  // One worker so LibRaw loads once and every number after `cold` is steady-state for that worker.
  const fast = createImageFast({ plugins: [raw], workers: 1, idleMs: 60_000 });
  for (const file of raws) {
    const cold = await timed(() => fast.decodeRaw(file, { width: 1024 }));
    const dims = await repeat(cfg.iterations, () => fast.dimensions(file));
    const embedded = await repeat(cfg.iterations, () => fast.decodeRaw(file, { width: 1024 }));
    const demosaic = await repeat(3, () => fast.decodeRaw(file, { width: 1_000_000 }));
    const thumb = await repeat(cfg.iterations, () => fast.thumbnail(file, { width: 1024 }));
    const info = cold.value;
    const dm = await fast.decodeRaw(file, { width: 1_000_000 });
    rows.push({
      camera: info.camera,
      bytes: file.size,
      width: info.width,
      height: info.height,
      coldMs: round(cold.ms),
      dimensionsMs: dims.median,
      embeddedMs: embedded.median,
      embeddedMethod: info.method,
      embeddedPreview: `${info.previewWidth}×${info.previewHeight}`,
      demosaicMs: demosaic.median,
      demosaicMethod: dm.method,
      demosaicSize: `${dm.previewWidth}×${dm.previewHeight}`,
      thumbnailMs: thumb.median,
    });
    log(
      `raw ${info.camera}: cold ${round(cold.ms)}, dims ${dims.median}, embedded ${embedded.median} (${info.method}), demosaic ${demosaic.median} (${dm.method}), thumb ${thumb.median}`,
    );
  }
  fast.terminate();
  // Throughput: all files at once on a fresh pool, LibRaw loading cold in every worker.
  const pool = createImageFast({ plugins: [raw] });
  const all = await monitored(() => Promise.all(raws.map((f) => pool.decodeRaw(f, { width: 1024 }))));
  pool.terminate();
  const parallel = { files: raws.length, totalBytes: raws.reduce((n, f) => n + f.size, 0), ms: all.ms, maxGap: all.maxGap, longFrames: all.longFrames };
  log(`raw parallel: ${JSON.stringify(parallel)}`);
  return { rows, parallel };
}

async function benchPlugins(cfg: Config, real: Record<string, File>) {
  const files: { format: string; file: File }[] = [{ format: 'PSD 4000×3000 raw RGB (synthetic)', file: synthPsd(4000, 3000) }];
  if (real.tiff) files.push({ format: 'TIFF (real file)', file: real.tiff });
  if (real.heic) files.push({ format: 'HEIC (real file, libheif-js)', file: real.heic });
  const fast = createImageFast({ plugins: [tiff, psd, heic], workers: 1, idleMs: 60_000 });
  const rows = [];
  for (const { format, file } of files) {
    const cold = await timed(() => fast.thumbnail(file, { width: 1024 }));
    const warm = await repeat(cfg.iterations, () => fast.thumbnail(file, { width: 1024 }));
    const t = cold.value;
    rows.push({
      format,
      bytes: file.size,
      source: `${t.sourceWidth}×${t.sourceHeight}`,
      decodedBy: t.decodedBy ?? 'browser',
      coldMs: round(cold.ms),
      warmMs: warm.median,
    });
    log(`plugin ${format}: cold ${round(cold.ms)} warm ${warm.median} (${t.decodedBy})`);
  }
  fast.terminate();
  return rows;
}

declare global {
  interface Window {
    runBench(cfg: Config): Promise<unknown>;
  }
}

window.runBench = async (cfg: Config) => {
  const real: Record<string, File> = {};
  const raws: File[] = [];
  for (const f of cfg.fixtures) {
    const file = await fetchFile(f);
    if (f.kind === 'raw') raws.push(file);
    else real[f.kind] = file;
  }
  log(`fixtures: ${raws.length} RAW, ${Object.keys(real).join(', ') || 'no'} real files; hardwareConcurrency ${navigator.hardwareConcurrency}`);
  const out = {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    dimensions: await benchDimensions(cfg, real),
    thumbnails: await benchThumbnails(cfg),
    plugins: await benchPlugins(cfg, real),
    raw: await benchRaw(cfg, raws),
  };
  return out;
};
