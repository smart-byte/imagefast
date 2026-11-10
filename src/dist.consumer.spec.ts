import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { loadPlugin } from './ops';
import type { ImageFastPlugin } from './plugin';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';

/**
 * Builds a throwaway app against dist/ (run `npm run build` first) the way a consumer's Vite would, then checks that
 * every module the workers load at runtime can actually be found in the output. The pre-built worker assets are
 * copied verbatim by the consumer's bundler, so a relative import of a sibling chunk (renamed by the consumer) or a
 * bare package specifier inside one only fails at runtime, inside the worker.
 */
const DIST = resolve(__dirname, '../dist');
const PLUGINS = ['raw', 'tiff', 'psd', 'heic'];

/** Specifiers a module loads: static/dynamic imports and `new URL(..., import.meta.url)` assets. */
function references(code: string): string[] {
  const out: string[] = [];
  for (const re of [
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\b(?:from|import)\s*["']([^"']+)["']/g,
    /new URL\(\s*(?:\/\*.*?\*\/\s*)*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g,
  ]) {
    for (const m of code.matchAll(re)) if (!m[1]!.includes('${')) out.push(m[1]!); // skip template text such as error messages
  }
  return out;
}

async function consumerBuild(): Promise<{ out: string; modules: { name: string; code: string; inline: boolean }[] }> {
  if (!existsSync(join(DIST, 'imagefast.js'))) throw new Error('dist/ missing: run `npm run build` before this spec');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'imagefast-consumer-'))); // Vite rejects a symlinked root (macOS /tmp)
  const imports = PLUGINS.map((p) => `import { ${p} } from ${JSON.stringify(join(DIST, `${p}.js`))};`);
  await writeFile(join(root, 'index.html'), '<script type="module" src="./main.js"></script>');
  await writeFile(
    join(root, 'main.js'),
    [`import { createImageFast } from ${JSON.stringify(join(DIST, 'imagefast.js'))};`, ...imports, `createImageFast({ plugins: [${PLUGINS}] });`].join('\n'),
  );
  await build({ root, configFile: false, logLevel: 'silent', build: { outDir: 'out' } });
  const out = join(root, 'out');
  const modules = [];
  for (const name of await readdir(join(out, 'assets'))) {
    if (!name.endsWith('.js')) continue;
    const code = await readFile(join(out, 'assets', name), 'utf8');
    modules.push({ name: `assets/${name}`, code, inline: false });
    // Small assets are inlined as data: URLs; a module loaded from one cannot import anything at all.
    for (const m of code.matchAll(/data:text\/javascript;base64,([A-Za-z0-9+/=]+)/g)) {
      modules.push({ name: `data: URL in ${name}`, code: Buffer.from(m[1]!, 'base64').toString('utf8'), inline: true });
    }
  }
  return { out, modules };
}

describe('dist/ inside a consumer build', () => {
  it("ships plugin modules that pass imagefast's own loader (Vite drops worker entry exports unless told otherwise)", async () => {
    if (!existsSync(join(DIST, 'imagefast.js'))) throw new Error('dist/ missing: run `npm run build` before this spec');
    for (const name of PLUGINS) {
      const plugin: ImageFastPlugin = (await import(/* @vite-ignore */ join(DIST, `${name}.js`)))[name];
      await expect(loadPlugin(plugin)).resolves.toBeUndefined();
    }
  });

  it('ships the licence texts of the libraries bundled into it', () => {
    const licences = ['libraw', 'libheif', 'utif', 'pako'].map((name) => `${name}.LICENSE.txt`);
    expect(licences.filter((file) => !existsSync(join(DIST, file)))).toEqual([]);
  });

  it('ships type declarations whose relative imports all resolve (a consumer without skipLibCheck type-checks them)', async () => {
    const broken: string[] = [];
    for (const name of (await readdir(DIST)).filter((file) => file.endsWith('.d.ts'))) {
      const code = (await readFile(join(DIST, name), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, ''); // doc comments quote example imports
      for (const spec of references(code)) {
        if (spec.startsWith('.') && !existsSync(join(DIST, `${spec.replace(/\.js$/, '')}.d.ts`))) broken.push(`${name} -> ${spec}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('emits every file the main thread and the workers load at runtime', async () => {
    const { out, modules } = await consumerBuild();
    try {
      const broken: string[] = [];
      for (const { name, code, inline } of modules) {
        for (const spec of references(code)) {
          if (spec.startsWith('data:')) continue;
          if (inline || !/^(\.{1,2}(\/|$)|\/)/.test(spec)) broken.push(`${name} -> ${spec}`);
          else if (!existsSync(join(out, spec.startsWith('/') ? spec : posix.join(posix.dirname(name), spec)))) broken.push(`${name} -> ${spec} (missing)`);
        }
      }
      expect(broken).toEqual([]);
    } finally {
      await rm(join(out, '..'), { recursive: true, force: true });
    }
  }, 60_000);
});
