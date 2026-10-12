import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

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
      'sharp',
      'algoliasearch',
    ],
  },
  {
    name: 'media',
    entry: 'functions-media/lib/functions-media/src/index.js',
    // Media functions enqueue/relay work to the process-audio services. Native
    // processing belongs there and must not creep back into function startup.
    disallow: ['algoliasearch', 'node-vibrant', 'fast-average-color-node', 'ffmpeg-static', 'ffprobe-static', '@ts-ffmpeg/fluent-ffmpeg', 'ytdl-core'],
    requiredExports: ['addintrooutrotaskgenerator', 'processaudiofiletask', 'processaudioyoutubetask', 'sermonaudiocreatetrigger'],
  },
  {
    name: 'image',
    entry: 'functions-image/lib/functions-image/src/index.js',
    disallow: ['ffmpeg-static', '@ts-ffmpeg/fluent-ffmpeg', 'ytdl-core', 'algoliasearch'],
    requireAny: ['node-vibrant', 'fast-average-color-node', 'image-size'],
  },
  {
    name: 'integrations',
    entry: 'functions-integrations/lib/functions-integrations/src/index.js',
    disallow: ['ffmpeg-static', '@ts-ffmpeg/fluent-ffmpeg', 'ytdl-core', 'node-vibrant', 'fast-average-color-node'],
  },
];

function loadedPackageNames() {
  const packages = new Set();
  for (const key of Object.keys(require.cache)) {
    const marker = `${path.sep}node_modules${path.sep}`;
    // pnpm's isolated linker nests another node_modules directory inside .pnpm.
    const idx = key.lastIndexOf(marker);
    if (idx === -1) continue;

    const rest = key.slice(idx + marker.length);
    const parts = rest.split(path.sep);
    if (parts.length === 0) continue;

    const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : parts[0];
    packages.add(name);
  }
  return packages;
}

const selectedTarget = process.argv[2] === '--target' ? process.argv[3] : undefined;
let hasFailure = false;

for (const target of targets) {
  if (!selectedTarget) {
    // Each deployed codebase has its own process. Use the same isolation here
    // instead of leaking SDK globals and package caches across codebases.
    const child = spawnSync(process.execPath, [__filename, '--target', target.name], { stdio: 'inherit', env: process.env, timeout: 60000 });
    if (child.error) console.error(`[${target.name}] startup check failed:`, child.error);
    if (child.status !== 0 || child.error) hasFailure = true;
    continue;
  }
  if (target.name !== selectedTarget) continue;
  const entryPath = path.join(repoRoot, target.entry);
  let entry;
  try {
    entry = require(entryPath);
  } catch (error) {
    hasFailure = true;
    console.error(`[${target.name}] failed to require entrypoint: ${entryPath}`);
    console.error(error);
    continue;
  }

  const packages = loadedPackageNames();
  const missingExports = (target.requiredExports ?? []).filter((name) => typeof entry[name] !== 'function' || !entry[name].__endpoint);
  if (missingExports.length) {
    hasFailure = true;
    console.error(`[${target.name}] missing Firebase function exports: ${missingExports.join(', ')}`);
  }
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

if (selectedTarget && !targets.some((target) => target.name === selectedTarget)) {
  hasFailure = true;
  console.error(`Unknown startup target: ${selectedTarget}`);
}

if (hasFailure) {
  process.exitCode = 1;
  console.error('Startup load guard failed.');
} else if (!selectedTarget) {
  console.log('Startup load guard passed.');
}
