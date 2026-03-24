import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const targets = [
  {
    name: 'core',
    entry: 'functions-core/lib/functions-core/src/index.js',
    disallow: [
      'firebase',
      '@firebase/firestore',
      'ffmpeg-static',
      'ffprobe-static',
      '@ts-ffmpeg/fluent-ffmpeg',
      'ytdl-core',
      'node-vibrant',
      'fast-average-color-node',
      'buffer-image-size',
      'sharp',
      'algoliasearch',
    ],
  },
  {
    name: 'media',
    entry: 'functions-media/lib/functions-media/src/index.js',
    disallow: ['algoliasearch', 'node-vibrant', 'fast-average-color-node'],
    requireAny: ['ffmpeg-static', '@ts-ffmpeg/fluent-ffmpeg', 'ytdl-core'],
  },
  {
    name: 'image',
    entry: 'functions-image/lib/functions-image/src/index.js',
    disallow: ['ffmpeg-static', '@ts-ffmpeg/fluent-ffmpeg', 'ytdl-core', 'algoliasearch'],
    requireAny: ['node-vibrant', 'fast-average-color-node', 'buffer-image-size'],
  },
  {
    name: 'integrations',
    entry: 'functions-integrations/lib/functions-integrations/src/index.js',
    disallow: ['ffmpeg-static', '@ts-ffmpeg/fluent-ffmpeg', 'ytdl-core', 'node-vibrant', 'fast-average-color-node'],
  },
];

function clearProjectCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(repoRoot)) {
      delete require.cache[key];
    }
  }
}

function loadedPackageNames() {
  const packages = new Set();
  for (const key of Object.keys(require.cache)) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const idx = key.indexOf(marker);
    if (idx === -1) continue;

    const rest = key.slice(idx + marker.length);
    const parts = rest.split(path.sep);
    if (parts.length === 0) continue;

    const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : parts[0];
    packages.add(name);
  }
  return packages;
}

let hasFailure = false;

for (const target of targets) {
  clearProjectCache();
  const entryPath = path.join(repoRoot, target.entry);
  try {
    require(entryPath);
  } catch (error) {
    hasFailure = true;
    console.error(`[${target.name}] failed to require entrypoint: ${entryPath}`);
    console.error(error);
    continue;
  }

  const packages = loadedPackageNames();
  const violations = target.disallow.filter((pkg) => packages.has(pkg));

  if (violations.length > 0) {
    hasFailure = true;
    console.error(`[${target.name}] disallowed packages loaded: ${violations.join(', ')}`);
  }

  if (target.requireAny) {
    const missing = target.requireAny.filter((pkg) => !packages.has(pkg));
    if (missing.length === target.requireAny.length) {
      hasFailure = true;
      console.error(`[${target.name}] expected at least one package to load: ${target.requireAny.join(', ')}`);
    }
  }

  console.log(`[${target.name}] loaded ${packages.size} packages`);
}

if (hasFailure) {
  process.exitCode = 1;
  console.error('Startup load guard failed.');
} else {
  console.log('Startup load guard passed.');
}
