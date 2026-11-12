import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIconSet } from './make-icons.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const BROWSERS = ['chrome', 'firefox'];

const ENTRY_POINTS = {
  content: join(ROOT, 'src', 'content', 'index.ts'),
  background: join(ROOT, 'src', 'background', 'index.ts'),
  popup: join(ROOT, 'src', 'popup', 'popup.ts'),
};

function manifestFor(browser) {
  const base = {
    manifest_version: 3,
    name: 'Ozon Product Collector',
    short_name: 'Ozon Collector',
    version: pkg.version,
    description:
      'Собирает карточки товаров из поиска и каталога Ozon в локальное хранилище браузера и экспортирует CSV/JSON.',
    permissions: ['storage', 'unlimitedStorage'],
    host_permissions: ['https://*.ozon.ru/*', 'https://ozon.ru/*'],
    content_scripts: [
      {
        matches: ['https://*.ozon.ru/*', 'https://ozon.ru/*'],
        js: ['content.js'],
        run_at: 'document_idle',
      },
    ],
    action: {
      default_title: 'Ozon Product Collector',
      default_popup: 'popup.html',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  };

  if (browser === 'chrome') {
    return {
      ...base,
      minimum_chrome_version: '111',
      background: { service_worker: 'background.js' },
    };
  }

  return {
    ...base,
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: {
        id: 'ozon-product-collector@local.extension',
        strict_min_version: '142.0',
        // Firefox requires an explicit statement about data collection.
        // The extension stores everything locally and transmits nothing.
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
  };
}

async function bundle(browser) {
  const outdir = join(DIST, browser);
  await build({
    entryPoints: ENTRY_POINTS,
    outdir,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: browser === 'chrome' ? ['chrome110'] : ['firefox115'],
    charset: 'utf8',
    legalComments: 'none',
    sourcemap: false,
    minify: false,
    logLevel: 'warning',
  });
  return outdir;
}

function copyStatic(outdir) {
  copyFileSync(join(ROOT, 'src', 'popup', 'popup.html'), join(outdir, 'popup.html'));
  copyFileSync(join(ROOT, 'src', 'popup', 'popup.css'), join(outdir, 'popup.css'));
}

function validate(outdir, browser) {
  const manifestPath = join(outdir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const required = [
    'manifest.json',
    'background.js',
    'content.js',
    'popup.html',
    'popup.css',
    'popup.js',
    'icons/icon-16.png',
    'icons/icon-32.png',
    'icons/icon-48.png',
    'icons/icon-128.png',
  ];
  for (const file of required) {
    if (!existsSync(join(outdir, file))) {
      throw new Error(`${browser}: missing build artifact ${file}`);
    }
  }
  if (manifest.manifest_version !== 3) throw new Error(`${browser}: must be Manifest V3`);
  if (manifest.version !== pkg.version) throw new Error(`${browser}: version mismatch`);
  if (browser === 'chrome' && !manifest.background?.service_worker) {
    throw new Error('chrome: background.service_worker is required');
  }
  if (browser === 'firefox' && (!manifest.background?.scripts || !manifest.browser_specific_settings)) {
    throw new Error('firefox: background.scripts and browser_specific_settings are required');
  }
  for (const resource of manifest.content_scripts[0].js) {
    if (!existsSync(join(outdir, resource))) throw new Error(`${browser}: missing content script ${resource}`);
  }
  for (const icon of Object.values(manifest.icons)) {
    if (!existsSync(join(outdir, icon))) throw new Error(`${browser}: missing icon ${icon}`);
  }
  return manifest;
}

function zipDirectory(directory, zipPath) {
  if (existsSync(zipPath)) rmSync(zipPath);
  try {
    execFileSync('zip', ['-r', '-q', '-X', zipPath, '.'], {
      cwd: directory,
      stdio: 'pipe',
    });
    return statSync(zipPath).size;
  } catch (error) {
    throw new Error(`Не удалось создать ${zipPath}: ${error instanceof Error ? error.message : error}`);
  }
}

async function main() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const summary = [];
  for (const browser of BROWSERS) {
    const outdir = await bundle(browser);
    copyStatic(outdir);
    writeFileSync(join(outdir, 'manifest.json'), `${JSON.stringify(manifestFor(browser), null, 2)}\n`);
    writeIconSet(join(outdir, 'icons'));
    validate(outdir, browser);

    const zipPath = join(DIST, `ozon-collector-${browser}.zip`);
    const zipBytes = zipDirectory(outdir, zipPath);
    const jsBytes =
      statSync(join(outdir, 'content.js')).size +
      statSync(join(outdir, 'background.js')).size +
      statSync(join(outdir, 'popup.js')).size;
    summary.push({ browser, outdir, zipPath, zipBytes, jsBytes });
  }

  for (const item of summary) {
    console.log(
      `${item.browser}: ${item.outdir}\n` +
        `  JS: ${(item.jsBytes / 1024).toFixed(1)} KiB\n` +
        `  ZIP: ${item.zipPath} (${(item.zipBytes / 1024).toFixed(1)} KiB)`,
    );
  }
  console.log('Сборка завершена: распакованные расширения и ZIP-архивы лежат в dist/.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
