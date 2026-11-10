import { createImageFast } from '../src/imagefast';
import { detect } from '../src/ops';
import sampleUrl from './assets/alpine-lake.jpg';

const $ = (id) => document.getElementById(id);
const workbench = $('workbench');
const poolSize = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
const pluginLoaders = {
  raw: () => import('../src/raw-plugin').then((module) => module.raw),
  tiff: () => import('../src/tiff-plugin').then((module) => module.tiff),
  psd: () => import('../src/psd-plugin').then((module) => module.psd),
  heic: () => import('../src/heic-plugin').then((module) => module.heic),
};
const pluginPromises = new Map();
const listenerController = new AbortController();
const listen = (node, event, handler) => node.addEventListener(event, handler, { signal: listenerController.signal });
const supported = typeof Worker !== 'undefined' && typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined';
let engine;
let engineKey = '';
let files = [];
let results = [];
let sample;
let samplePromise;
let usingSample = true;
let mode = 'single';
let outputType = 'image/webp';
let state = 'loading';
let token = 0;
let sourceUrl;
let statsTimer;
let disposed = false;
let dragDepth = 0;
let initialObserver;
const outputUrls = new Set();
const feedbackTimers = new Set();
const mimeLabels = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
  'image/gif': 'GIF',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',
};
const mimeExtensions = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function bytes(value) {
  return value >= 1e6 ? `${(value / 1e6).toFixed(2)} MB` : value >= 1000 ? `${(value / 1000).toFixed(1)} kB` : `${value} B`;
}
function time(value) {
  return value < 1 ? `${value.toFixed(2)} ms` : value < 100 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`;
}
function dimensions(width, height) {
  return `${width.toLocaleString('en-US')} × ${height.toLocaleString('en-US')}`;
}
function setMessage(message) {
  $('lab-message').hidden = !message;
  $('lab-message').textContent = message;
}
function announce(message) {
  $('announcement').textContent = message;
}
function updateSnapshot(extra = {}) {
  window.imagefastDemoSnapshot = {
    mode,
    state,
    inputCount: files.length,
    outputType,
    results: results.map(
      (result) =>
        result && {
          name: result.file.name,
          error: result.error,
          width: result.thumbnail?.width,
          height: result.thumbnail?.height,
          bytes: result.thumbnail?.blob.size,
          type: result.thumbnail?.blob.type,
          method: result.dimensions?.method,
          decodedBy: result.thumbnail?.decodedBy,
        },
    ),
    stats: engine?.stats() || {
      size: poolSize,
      workers: 0,
      busy: 0,
      queued: 0,
    },
    ...extra,
  };
}
function setState(next) {
  state = next;
  workbench.dataset.state = next;
  $('process').disabled = !supported || !files.length || next === 'loading';
  $('process').querySelector('span').textContent =
    next === 'processing' ? 'Cancel' : next === 'dirty' ? 'Apply settings' : mode === 'batch' ? 'Run batch' : 'Run';
  $('download').disabled = mode !== 'single' || !results[0]?.thumbnail || next === 'processing' || next === 'dirty';
  $('download').hidden = mode === 'batch';
  updateSnapshot();
}
function updateLog() {
  const options = `width: ${$('target-width').value}, type: '${outputType}'`;
  $('lab-log').textContent =
    mode === 'single' ? `fast.thumbnail(photo, { ${options} })` : `Promise.all(photos.map(photo => fast.thumbnail(photo, { ${options} })))`;
}
function markDirty() {
  if (state === 'processing') cancelWork();
  if (!files.length) return;
  setState('dirty');
  $('lab-timing').textContent = 'Settings changed';
  updateLog();
  announce('Settings changed. Apply settings to update the result.');
}
function clearResults() {
  outputUrls.forEach((url) => URL.revokeObjectURL(url));
  outputUrls.clear();
  results = new Array(files.length);
  $('result-image').hidden = true;
  $('result-image').removeAttribute('src');
  $('savings-badge').hidden = true;
  $('result-bytes').textContent = '—';
  $('result-dimensions').textContent = `${$('target-width').value} px wide`;
  $('output-empty').hidden = mode === 'batch';
  $('batch-results').hidden = mode !== 'batch';
  $('batch-results').replaceChildren();
  $('result-format').textContent = mimeLabels[outputType];
  $('probe-step').textContent = '—';
  $('resize-step').textContent = '—';
  if (mode === 'batch') {
    files.forEach((file, index) => {
      const button = document.createElement('button');
      button.className = 'batch-result';
      button.type = 'button';
      button.disabled = true;
      button.textContent = String(index + 1).padStart(2, '0');
      button.setAttribute('aria-label', `${file.name}: waiting to process`);
      button.dataset.index = String(index);
      $('batch-results').append(button);
    });
  }
}
function updateSource() {
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = undefined;
  const file = files[0];
  if (!file) return;
  const format = mimeLabels[file.type] || file.name.split('.').pop().toUpperCase().slice(0, 7);
  $('source-format').textContent = format;
  $('source-name').textContent = file.name;
  $('source-bytes').textContent = bytes(files.reduce((total, input) => total + input.size, 0));
  $('source-dimensions').textContent = mode === 'batch' ? `${files.length} originals` : 'Reading dimensions…';
  $('batch-count').hidden = mode !== 'batch';
  $('batch-count').textContent = `${files.length} photos`;
  $('sample-note').textContent = usingSample
    ? mode === 'batch'
      ? '12 copies of the sample photo.'
      : 'Sample photo, AI-generated.'
    : 'Processed locally, in this tab.';
  // Browsers can preview their native formats before Imagefast processes them.
  const nativePreview = /^image\/(jpeg|png|webp|gif|avif|bmp)$/.test(file.type);
  $('source-image').hidden = !nativePreview;
  $('source-placeholder').hidden = nativePreview;
  $('source-placeholder-label').textContent = `${format} file`;
  $('source-image').alt = usingSample ? 'Sample alpine lake photograph, before processing' : 'Your selected original image';
  if (nativePreview) {
    sourceUrl = URL.createObjectURL(file);
    $('source-image').src = sourceUrl;
  } else $('source-image').removeAttribute('src');
}

async function getEngine(selectedFiles, currentToken) {
  const containers = await Promise.all(selectedFiles.map(async (file) => detect(file, new Uint8Array(await file.slice(0, 64).arrayBuffer()))));
  const required = [...new Set(containers.filter((container) => container !== 'native'))].sort();
  const plugins = await Promise.all(
    required.map((container) => {
      if (!pluginPromises.has(container)) pluginPromises.set(container, pluginLoaders[container]());
      return pluginPromises.get(container);
    }),
  );
  if (currentToken !== token || disposed) return null;
  const key = required.join(',');
  if (!engine || key !== engineKey) {
    engine?.terminate();
    engine = createImageFast({ workers: poolSize, idleMs: 5000, plugins });
    engineKey = key;
  }
  return engine;
}

function paintStats() {
  if (disposed) return;
  const stats = engine?.stats() || {
    size: poolSize,
    workers: 0,
    busy: 0,
    queued: 0,
  };
  const slots = [...$('worker-slots').children];
  slots.forEach((slot, index) => {
    slot.hidden = index >= poolSize;
    slot.classList.toggle('busy', index < stats.busy);
    slot.classList.toggle('live', index >= stats.busy && index < stats.workers);
  });
  $('worker-status').textContent = stats.busy
    ? `${stats.busy} busy · ${stats.queued} queued`
    : stats.workers
      ? `${stats.workers} worker${stats.workers === 1 ? '' : 's'} ready`
      : `Up to ${poolSize} workers`;
  if (statsTimer) clearTimeout(statsTimer);
  if (state === 'processing' || stats.workers) statsTimer = setTimeout(paintStats, state === 'processing' ? 35 : 300);
  updateSnapshot();
}

function paintResult(index) {
  const result = results[index];
  if (!result?.thumbnail) return;
  const { file, thumbnail, dimensions: size } = result;
  result.url = URL.createObjectURL(thumbnail.blob);
  outputUrls.add(result.url);
  if (index === 0) {
    if (mode === 'single') {
      $('source-dimensions').textContent = dimensions(size.width, size.height);
      $('result-dimensions').textContent = dimensions(thumbnail.width, thumbnail.height);
      $('result-bytes').textContent = bytes(thumbnail.blob.size);
      $('result-image').src = result.url;
      $('result-image').hidden = false;
      $('output-empty').hidden = true;
      $('result-format').textContent = mimeLabels[thumbnail.blob.type] || thumbnail.blob.type;
      const savings = (1 - thumbnail.blob.size / file.size) * 100;
      $('savings-badge').hidden = false;
      $('savings-badge').classList.toggle('larger', savings < 0);
      $('savings-badge').querySelector('span').textContent = `${Math.abs(savings).toFixed(0)}% ${savings >= 0 ? 'smaller' : 'larger'}`;
    }
    if ($('source-image').hidden) {
      $('source-image').src = result.url;
      $('source-image').alt = 'Decoded preview of your original file';
      $('source-image').hidden = false;
      $('source-placeholder').hidden = true;
    }
  }
  if (mode === 'batch') {
    const button = $('batch-results').children[index];
    const image = document.createElement('img');
    image.src = result.url;
    image.alt = '';
    button.replaceChildren(image);
    button.disabled = false;
    button.title = `${file.name} → ${dimensions(thumbnail.width, thumbnail.height)} · ${bytes(thumbnail.blob.size)}`;
    button.setAttribute('aria-label', `Download processed ${file.name}`);
    const complete = results.filter((entry) => entry?.thumbnail);
    $('result-dimensions').textContent = `${complete.length} / ${files.length} ready`;
    $('result-bytes').textContent = bytes(complete.reduce((total, entry) => total + entry.thumbnail.blob.size, 0));
  }
}

async function processImages() {
  if (!supported || !files.length || disposed) return;
  cancelWork(false);
  const currentToken = ++token;
  const selectedFiles = [...files];
  const settings = {
    width: Number($('target-width').value),
    quality: Number($('quality').value) / 100,
    type: outputType,
    // Apply the selected format even to small originals.
    reuseSourceBelowBytes: 0,
  };
  clearResults();
  setMessage('');
  setState('processing');
  updateLog();
  $('lab-timing').textContent = 'Preparing workers…';
  try {
    const activeEngine = await getEngine(selectedFiles, currentToken);
    if (!activeEngine) return;
    const startedAt = performance.now();
    paintStats();
    const outcomes = await Promise.allSettled(
      selectedFiles.map(async (file, index) => {
        try {
          const size = await activeEngine.dimensions(file);
          if (currentToken !== token) return;
          if (index === 0 && mode === 'single') {
            $('source-dimensions').textContent = dimensions(size.width, size.height);
            $('probe-step').textContent = time(size.ms);
          }
          const thumbnail = await activeEngine.thumbnail(file, settings);
          if (currentToken !== token || disposed) return;
          results[index] = { file, dimensions: size, thumbnail };
          paintResult(index);
          updateSnapshot();
        } catch (error) {
          if (currentToken !== token || disposed) return;
          results[index] = { file, error: error.message || String(error) };
          if (mode === 'batch') {
            const button = $('batch-results').children[index];
            button.textContent = '!';
            button.classList.add('failed');
            button.title = `${file.name}: ${results[index].error}`;
            button.setAttribute('aria-label', `${file.name}: could not process`);
          }
          throw error;
        }
      }),
    );
    if (currentToken !== token || disposed) return;
    const elapsed = performance.now() - startedAt;
    const completed = results.filter((result) => result?.thumbnail);
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected').length;
    const first = completed[0];
    $('probe-step').textContent = first ? time(first.dimensions.ms) : 'Failed';
    $('resize-step').textContent = first ? time(first.thumbnail.ms) : 'Failed';
    $('engine-note').textContent = first
      ? first.dimensions.method === 'header'
        ? 'Dimensions from the header.'
        : `Dimensions via ${first.dimensions.method}.`
      : 'Try another image.';
    $('lab-timing').textContent = `${time(elapsed)} · ${completed.length} ${mode === 'batch' ? `/ ${selectedFiles.length} ready` : 'image'}`;
    if (failures) {
      const failed = results.find((result) => result?.error);
      setMessage(
        `${failures === selectedFiles.length ? 'Could not process' : `${failures} file(s) could not be processed, including`} ${failed.file.name}: ${failed.error}`,
      );
      if (!completed.length) $('output-empty').querySelector('span').textContent = 'Try a different image.';
    }
    setState(completed.length ? 'done' : 'error');
    paintStats();
    announce(`${completed.length} image${completed.length === 1 ? '' : 's'} processed${failures ? `; ${failures} failed` : ''}.`);
    updateSnapshot({ elapsed });
  } catch (error) {
    if (currentToken !== token || disposed) return;
    setMessage(`Could not start image processing: ${error.message || error}. Try another image or reload the page.`);
    $('lab-timing').textContent = 'Unable to process';
    setState('error');
    paintStats();
  }
}

function cancelWork(showMessage = true) {
  token += 1;
  if (state === 'processing') engine?.terminate();
  clearTimeout(statsTimer);
  if (showMessage) {
    setState(files.length ? 'ready' : 'loading');
    $('lab-timing').textContent = 'Cancelled';
    announce('Processing cancelled. You can run it again.');
    paintStats();
  }
}

async function loadSample() {
  if (!samplePromise) {
    samplePromise = fetch(sampleUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error('The sample photograph could not be loaded.');
        return new File([await response.blob()], 'alpine-lake.jpg', {
          type: 'image/jpeg',
        });
      })
      .catch((error) => {
        samplePromise = null;
        throw error;
      });
  }
  return samplePromise;
}
async function useSample() {
  initialObserver?.disconnect();
  cancelWork(false);
  const currentToken = token;
  setState('loading');
  setMessage('');
  try {
    sample = await loadSample();
    if (currentToken !== token || disposed) return;
    usingSample = true;
    files =
      mode === 'single'
        ? [sample]
        : Array.from({ length: 12 }, (_, index) => new File([sample], `alpine-${String(index + 1).padStart(2, '0')}.jpg`, { type: sample.type }));
    updateSource();
    await processImages();
  } catch (error) {
    if (currentToken !== token || disposed) return;
    setMessage(`${error.message} You can still choose your own photo.`);
    setState('error');
    $('lab-timing').textContent = 'Sample unavailable';
  }
}
async function chooseFiles(selected) {
  if (!selected.length) return;
  initialObserver?.disconnect();
  if (selected.length > 24) {
    setMessage('Choose up to 24 photos at a time.');
    return;
  }
  cancelWork(false);
  files = [...selected];
  usingSample = false;
  setMode(files.length > 1 ? 'batch' : 'single');
  updateSource();
  await processImages();
}
function setMode(next) {
  mode = next;
  workbench.dataset.mode = mode;
  document.querySelectorAll('.mode-switch button').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  updateLog();
}
function downloadResult(index) {
  const result = results[index];
  if (!result?.thumbnail || !result.url) return;
  const extension = mimeExtensions[result.thumbnail.blob.type] || 'img';
  const link = document.createElement('a');
  link.href = result.url;
  link.download = `${result.file.name.replace(/\.[^.]+$/, '') || 'image'}-${result.thumbnail.width}.${extension}`;
  document.body.append(link);
  link.click();
  link.remove();
}

listen($('process'), 'click', () => (state === 'processing' ? cancelWork() : processImages()));
listen($('use-sample'), 'click', useSample);
listen($('choose-files'), 'click', () => $('file-input').click());
listen($('file-input'), 'change', () => {
  const selected = [...$('file-input').files];
  $('file-input').value = '';
  chooseFiles(selected);
});
listen($('download'), 'click', () => downloadResult(0));
listen($('batch-results'), 'click', (event) => {
  const button = event.target.closest('button[data-index]');
  if (button && !button.disabled) downloadResult(Number(button.dataset.index));
});
listen($('source-image'), 'error', () => {
  $('source-image').hidden = true;
  $('source-placeholder').hidden = false;
  $('source-placeholder-label').textContent = 'Original file';
});
listen($('target-width'), 'change', markDirty);
listen($('quality'), 'input', () => {
  $('quality-value').textContent = `${$('quality').value}%`;
  $('quality').style.setProperty('--quality', `${$('quality').value}%`);
  markDirty();
});
document.querySelectorAll('[data-format]').forEach((button) => {
  listen(button, 'click', () => {
    if (outputType === button.dataset.format) return;
    outputType = button.dataset.format;
    document.querySelectorAll('[data-format]').forEach((option) => {
      const active = option.dataset.format === outputType;
      option.classList.toggle('active', active);
      option.setAttribute('aria-pressed', String(active));
    });
    $('quality').disabled = outputType === 'image/png';
    $('quality-value').textContent = outputType === 'image/png' ? 'Lossless' : `${$('quality').value}%`;
    markDirty();
  });
});
document.querySelectorAll('.mode-switch button').forEach((button) => {
  listen(button, 'click', async () => {
    if (mode === button.dataset.mode) return;
    cancelWork(false);
    setMode(button.dataset.mode);
    if (usingSample || !files.length) await useSample();
    else {
      if (mode === 'single') files = [files[0]];
      updateSource();
      await processImages();
    }
  });
});

listen($('drop-zone'), 'dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  $('drop-zone').classList.add('dragging');
});
listen($('drop-zone'), 'dragover', (event) => event.preventDefault());
listen($('drop-zone'), 'dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop-zone').classList.remove('dragging');
});
listen($('drop-zone'), 'drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  $('drop-zone').classList.remove('dragging');
  chooseFiles([...event.dataTransfer.files]);
});

async function copyText(text, button) {
  const feedback = button.querySelector('.copy-feedback') || button.querySelector('span');
  try {
    await navigator.clipboard.writeText(text);
    const original = (button.dataset.copyLabel ??= feedback.textContent);
    button.classList.add('copied');
    feedback.textContent = 'Copied';
    announce('Copied to clipboard.');
    const timeout = setTimeout(() => {
      button.classList.remove('copied');
      feedback.textContent = original;
      feedbackTimers.delete(timeout);
    }, 1700);
    feedbackTimers.add(timeout);
  } catch {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(button.dataset.copy ? button.querySelector('code') : $('code-example'));
    selection.removeAllRanges();
    selection.addRange(range);
    announce('Clipboard unavailable. Text selected; use your keyboard to copy.');
  }
}
document.querySelectorAll('[data-copy]').forEach((button) => listen(button, 'click', () => copyText(button.dataset.copy, button)));
listen($('copy-code'), 'click', () => copyText($('code-example').textContent, $('copy-code')));

const root = document.documentElement;
function paintTheme() {
  $('theme-toggle').setAttribute('aria-pressed', String(root.dataset.theme === 'dark'));
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue('--bg').trim();
}
listen($('theme-toggle'), 'click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('theme', root.dataset.theme);
  } catch {
    // Storage is blocked (private mode): the choice lasts for this page view.
  }
  paintTheme();
});
paintTheme();

$('download').setAttribute('aria-label', 'Download processed image');
paintStats();
if (supported) {
  initialObserver = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) {
        initialObserver.disconnect();
        useSample();
      }
    },
    { threshold: 0.05 },
  );
  initialObserver.observe(workbench);
} else {
  setState('error');
  setMessage('The demo needs a browser with module workers, createImageBitmap and OffscreenCanvas.');
  $('lab-timing').textContent = 'Browser support required';
  $('choose-files').disabled = true;
  $('use-sample').disabled = true;
  document.querySelectorAll('.mode-switch button, .format-switch button, #target-width, #quality').forEach((control) => {
    control.disabled = true;
  });
}

function dispose() {
  disposed = true;
  token += 1;
  engine?.terminate();
  clearTimeout(statsTimer);
  feedbackTimers.forEach(clearTimeout);
  initialObserver?.disconnect();
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  outputUrls.forEach((url) => URL.revokeObjectURL(url));
  listenerController.abort();
}
if (import.meta.hot) import.meta.hot.dispose(dispose);
