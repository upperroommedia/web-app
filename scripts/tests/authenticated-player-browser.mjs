// CI-only authenticated UI checks. Never loads a real project or credential file.
import assert from 'node:assert/strict';
import { MEDIA_FIXTURE_ADMIN, MEDIA_FIXTURE_UPLOADER } from '../../apps/web/tests/helpers/mediaFixtureIdentity.ts';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, readdir, mkdtemp, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROJECT = 'demo-temporal-ci';
export const SPECS = Object.freeze([
  'tests/audio-player.spec.ts',
  'tests/audio-trimmer.spec.ts',
  'tests/player-clear-on-upload.spec.ts',
]);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVICE_ENV = {
  auth: 'FIREBASE_AUTH_EMULATOR_HOST',
  firestore: 'FIRESTORE_EMULATOR_HOST',
  database: 'FIREBASE_DATABASE_EMULATOR_HOST',
  storage: 'FIREBASE_STORAGE_EMULATOR_HOST',
};
const owned = new WeakSet();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function seedMediaAdmin(auth) {
  assert.equal(auth.app.options.projectId, PROJECT, 'Demo Auth required for administrator');
  const { uid, email, displayName, providerUid, providerId, role } = MEDIA_FIXTURE_ADMIN;
  const result = await auth.importUsers([
    {
      uid,
      email,
      displayName,
      emailVerified: true,
      providerData: [{ uid: providerUid, providerId, email, displayName }],
      customClaims: { role },
    },
  ]);
  assert.equal(result.successCount, 1, 'Administrator import did not succeed');
  assert.equal(result.failureCount, 0, 'Administrator import failed');
  assert.deepEqual(result.errors, [], 'Administrator import errors');
  const actual = await auth.getUser(uid);
  assert.equal(actual.uid, uid);
  assert.equal(actual.email, email);
  assert.equal(actual.displayName, displayName);
  assert.equal(actual.emailVerified, true);
  assert.equal(actual.disabled, false);
  assert.deepEqual(actual.customClaims, { role });
  assert.equal(actual.providerData.length, 1);
  assert.deepEqual(
    actual.providerData.map(({ uid, providerId, email, displayName }) => ({ uid, providerId, email, displayName })),
    [{ uid: providerUid, providerId, email, displayName }]
  );
}

export function loadMediaFixtureSources(require) {
  const service = require('ts-node').register({
    project: resolve(ROOT, 'functions/tsconfig.json'),
    transpileOnly: true,
  });
  try {
    const source = require(resolve(ROOT, 'apps/web/shared/bundleConfigs.ts'));
    const configs = ['TOPIC', 'SUBTITLE', 'BIBLE_CHAPTER', 'SUNDAY_HOMILY', 'HOLY_WEEK', 'LATEST_LIST'].map(
      (name) => source[`${name}_BUNDLE_CONFIG`]
    );
    assert.equal(configs.length, 6);
    assert.equal(new Set(configs.map((config) => config.functionName)).size, 6);
    const { toDirectoryUser } = require(resolve(ROOT, 'functions/src/userDirectory.ts'));
    const { parseMediaBackendFixture } = require(resolve(ROOT, 'apps/web/tests/helpers/mediaBackendFixture.ts'));
    return { configs, toDirectoryUser, parseMediaBackendFixture };
  } finally {
    service.enabled(false);
  }
}

export async function buildMediaBackendFixture({ db, auth, database, configs, toDirectoryUser }) {
  assert.equal(db.projectId, PROJECT, 'Demo Firestore required for fixtures');
  assert.equal(auth.app.options.projectId, PROJECT, 'Demo Auth required for fixtures');
  assert.equal(database.app.options.projectId, PROJECT, 'Demo RTDB required for fixtures');
  const { uid, email, displayName, role } = MEDIA_FIXTURE_UPLOADER;
  await auth.createUser({
    uid,
    email,
    displayName,
    emailVerified: true,
  });
  await auth.setCustomUserClaims(uid, { role });
  const users = [toDirectoryUser(await auth.getUser(uid))];
  assert.equal(users[0].uid, uid);
  const bundles = {};
  for (const config of configs) {
    assert(/^[a-z]+bundle$/.test(config.functionName), 'Unexpected fixture endpoint');
    assert(!bundles[config.functionName], 'Duplicate fixture endpoint');
    let query = db.collection(config.collectionName);
    for (const condition of config.whereConditions ?? [])
      query = query.where(condition.field, condition.operator, condition.value);
    if (config.orderByField) query = query.orderBy(config.orderByField);
    const snapshot = await query.get();
    const timestamp = snapshot.readTime.toMillis();
    assert(Number.isSafeInteger(timestamp) && timestamp > 0);
    const body = db.bundle(`media-ci-${config.bundleType}`).add(config.namedQuery, snapshot).build();
    assert(
      Buffer.isBuffer(body) && body.length > 0 && body.length <= 1024 * 1024,
      'Invalid or oversized Firestore bundle'
    );
    bundles[config.functionName] = { namedQuery: config.namedQuery, bodyBase64: body.toString('base64'), timestamp };
    await database
      .ref(config.metadataDocPath)
      .set({ lastUpdated: timestamp, count: snapshot.size, storagePath: config.bundlePath });
  }
  assert.equal(Object.keys(bundles).length, 6);
  return { schemaVersion: 1, projectId: PROJECT, bundles, users };
}

export async function cleanupMediaSeed(db, database, app, deleteApp, originalError) {
  const errors = originalError ? [originalError] : [];
  for (const close of [() => db.terminate(), () => database.goOffline(), () => deleteApp(app)]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Demo fixture seed and cleanup failed');
}

export function isLoadedDotenv(name) {
  return /^\.env(?:\.(?:local|(?:development|production|test)(?:\.local)?))?$/.test(name);
}

export function emulatorPorts(config) {
  const ports = {};
  for (const name of ['auth', 'firestore', 'database', 'storage', 'functions', 'hub', 'logging', 'ui']) {
    const entry = config.emulators?.[name];
    assert(
      entry && (!entry.host || ['127.0.0.1', 'localhost'].includes(entry.host)),
      `Non-loopback or missing ${name}`
    );
    assert(Number.isInteger(entry.port) && entry.port > 0 && entry.port <= 65535, `Invalid ${name} port`);
    ports[name] = entry.port;
  }
  assert.equal(new Set(Object.values(ports)).size, Object.values(ports).length, 'Duplicate emulator ports');
  assert(!Object.values(ports).includes(3004), 'Next port conflicts with emulator');
  return ports;
}

export function isolatedEnvironment(inherited, ports) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'PNPM_HOME', 'CI', 'JAVA_HOME']) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  Object.assign(env, {
    CI: 'true',
    NODE_ENV: 'production',
    NEXT_PUBLIC_FIREBASE_DEMO_EMULATORS: 'true',
    GCLOUD_PROJECT: PROJECT,
    GOOGLE_CLOUD_PROJECT: PROJECT,
    FIREBASE_PROJECT_ID: PROJECT,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: PROJECT,
    NEXT_PUBLIC_FIREBASE_API_KEY: 'synthetic-public-browser-test-key',
    NEXT_PUBLIC_FIREBASE_APP_ID: '1:123456789:web:synthetic',
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${PROJECT}.firebaseapp.com`,
    NEXT_PUBLIC_FIREBASE_IMAGES_BUCKET: `${PROJECT}-images`,
    NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION: 'us-central1',
    NEXT_PUBLIC_FIREBASE_FUNCTIONS_URL: `http://127.0.0.1:${ports.functions}/${PROJECT}/us-central1`,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: `${PROJECT}.appspot.com`,
    NEXT_PUBLIC_FIREBASE_DATABASE_URL: `http://127.0.0.1:${ports.database}?ns=${PROJECT}`,
    FIREBASE_CONFIG: JSON.stringify({
      projectId: PROJECT,
      storageBucket: `${PROJECT}.appspot.com`,
      databaseURL: `http://127.0.0.1:${ports.database}?ns=${PROJECT}`,
    }),
    GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/ci-player-no-adc.json',
    GCE_METADATA_HOST: '127.0.0.1:9',
    METADATA_SERVER_DETECTION: 'none',
    URM_MEDIA_BROWSER_STATUS_FIXTURE: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
    PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:3004',
  });
  for (const name of ['auth', 'firestore', 'database', 'storage', 'functions'])
    env[`NEXT_PUBLIC_FIREBASE_${name.toUpperCase()}_EMULATOR_PORT`] = String(ports[name]);
  for (const [service, key] of Object.entries(SERVICE_ENV)) env[key] = `127.0.0.1:${ports[service]}`;
  return env;
}

const BUILD_RECEIPT = 'apps/web/.next/media-browser-build.json';
const BUILD_ROOTS = [
  'apps/web/.next/BUILD_ID',
  'apps/web/.next/required-server-files.json',
  'apps/web/.next/static',
  'apps/web/.next/server',
  'apps/web/.next/standalone/apps/web/server.js',
  'apps/web/.next/standalone/apps/web/.next/BUILD_ID',
  'apps/web/.next/standalone/apps/web/.next/server',
  'apps/web/.next/standalone/apps/web/.next/static',
  'apps/web/.next/standalone/apps/web/public',
];
export function productionConfiguration(env) {
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.NEXT_PUBLIC_FIREBASE_DEMO_EMULATORS, 'true');
  assert.equal(env.NEXT_PUBLIC_FIREBASE_PROJECT_ID, PROJECT);
  const expected = isolatedEnvironment({}, emulatorPorts(JSON.parse(requireConfigText())));
  const keys = Object.keys(expected).filter(
    (key) =>
      key.startsWith('NEXT_PUBLIC_') ||
      Object.values(SERVICE_ENV).includes(key) ||
      ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_PROJECT_ID', 'FIREBASE_CONFIG', 'NODE_ENV'].includes(key)
  );
  for (const key of keys) assert.equal(env[key], expected[key], `Wrong production demo configuration: ${key}`);
  return Object.fromEntries(keys.sort().map((key) => [key, env[key]]));
}
function requireConfigText() {
  return createRequire(import.meta.url)('node:fs').readFileSync(resolve(ROOT, 'firebase.test.json'), 'utf8');
}
async function buildFileHashes(root) {
  const files = {};
  async function visit(path) {
    const { lstat } = await import('node:fs/promises');
    const entry = await lstat(resolve(root, path));
    assert(!entry.isSymbolicLink(), `Unexpected build output symlink: ${path}`);
    if (entry.isDirectory()) {
      for (const name of (await readdir(resolve(root, path))).sort()) await visit(`${path}/${name}`);
    } else {
      assert(entry.isFile(), 'Expected regular production artifact');
      files[path] = createHash('sha256')
        .update(await readFile(resolve(root, path)))
        .digest('hex');
    }
  }
  for (const path of BUILD_ROOTS) await visit(path);
  return files;
}
export async function recordProductionBuild(root, env) {
  const configuration = productionConfiguration(env);
  const buildId = (await readFile(resolve(root, 'apps/web/.next/BUILD_ID'), 'utf8')).trim();
  assert(/^[A-Za-z0-9_-]{1,128}$/.test(buildId), 'Invalid production BUILD_ID');
  const pages = JSON.parse(await readFile(resolve(root, 'apps/web/.next/server/pages-manifest.json'), 'utf8'));
  for (const route of ['/api/uploadFile', '/api/editSermon'])
    assert(!(route in pages), `Browser helper exposed as HTTP route: ${route}`);
  const receipt = { schemaVersion: 1, buildId, configuration, files: await buildFileHashes(root) };
  await writeFile(resolve(root, BUILD_RECEIPT), JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
  return receipt;
}
export async function verifyProductionBuild(root, env) {
  const receipt = JSON.parse(await readFile(resolve(root, BUILD_RECEIPT), 'utf8'));
  assert.equal(receipt.schemaVersion, 1, 'Invalid production build receipt');
  assert.deepEqual(receipt.configuration, productionConfiguration(env), 'Compiled/runtime configuration differs');
  assert.equal(
    (await readFile(resolve(root, 'apps/web/.next/BUILD_ID'), 'utf8')).trim(),
    receipt.buildId,
    'Production BUILD_ID changed'
  );
  assert.deepEqual(await buildFileHashes(root), receipt.files, 'Production build output changed');
  return receipt;
}
export async function runOwnedBuild(env, args = ['--dir', 'apps/web', 'build'], executable = 'pnpm') {
  let child, failure;
  const abort = () => {
    failure ??= new Error('Production build interrupted');
    if (child?.pid && groupAlive(child)) process.kill(-child.pid, 'SIGTERM');
  };
  process.on('SIGTERM', abort);
  process.on('SIGINT', abort);
  try {
    child = start(args, env, executable);
    await child.result;
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Build interrupted and command failed') : error;
  } finally {
    try {
      await stop(child);
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Build and cleanup failed') : error;
    }
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
  }
  if (failure) throw failure;
}
export async function buildProduction(env, root = ROOT, runBuild = runOwnedBuild) {
  productionConfiguration(env);
  await rm(resolve(root, 'apps/web/.next'), { recursive: true, force: true });
  try {
    await runBuild(env);
    const output = resolve(root, 'apps/web/.next/standalone/apps/web');
    await cp(resolve(root, 'apps/web/public'), resolve(output, 'public'), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await cp(resolve(root, 'apps/web/.next/static'), resolve(output, '.next/static'), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await recordProductionBuild(root, env);
    await verifyProductionBuild(root, env);
  } catch (error) {
    try {
      await rm(resolve(root, BUILD_RECEIPT), { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Production build and receipt cleanup failed');
    }
    throw error;
  }
}

export function validateEmulatorContext(env, ports) {
  assert.equal(env.GCLOUD_PROJECT, PROJECT, 'Synthetic project required');
  for (const [service, key] of Object.entries(SERVICE_ENV))
    assert.equal(env[key], `127.0.0.1:${ports[service]}`, `Wrong dedicated ${service} emulator`);
}

export function emulatorCommand() {
  return [
    '--dir',
    'functions',
    'exec',
    'firebase',
    'emulators:exec',
    '--project',
    PROJECT,
    '--only',
    'auth,firestore,database,storage',
    '--config',
    '../firebase.test.json',
    'node ../scripts/tests/authenticated-player-browser.mjs --inside-emulators',
  ];
}

function start(args, env, executable = 'pnpm') {
  const child = spawn(executable, args, { cwd: ROOT, env, detached: true, stdio: 'inherit' });
  owned.add(child);
  child.result = new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0
        ? resolveResult()
        : reject(new Error(`Owned command failed (${code ?? signal}): ${args.slice(0, 5).join(' ')}`))
    );
  });
  // Attach immediately: cleanup still awaits the original error even if readiness fails first.
  child.result.catch(() => {});
  return child;
}
function groupAlive(child) {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function stop(child) {
  if (!child) return;
  assert(owned.has(child) && Number.isInteger(child.pid), 'Cannot stop an unowned process');
  if (!groupAlive(child)) return;
  process.kill(-child.pid, 'SIGTERM');
  for (let i = 0; i < 100 && groupAlive(child); i++) await delay(100);
  if (groupAlive(child)) {
    process.kill(-child.pid, 'SIGKILL');
    for (let i = 0; i < 50 && groupAlive(child); i++) await delay(100);
    assert(!groupAlive(child), 'Owned process group did not settle');
    throw new Error('Owned process required forced cleanup');
  }
}
async function portClosed(port) {
  return new Promise((resolveResult, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolveResult(false);
    });
    socket.once('error', (error) => (error.code === 'ECONNREFUSED' ? resolveResult(true) : reject(error)));
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`Port check timed out: ${port}`));
    });
  });
}
async function assertClosed(ports) {
  for (const port of ports)
    assert(await portClosed(port), `Port ${port} occupied; refusing to reuse or stop another process`);
}
async function coldNavigation(env) {
  await assertClosed([3002]);
  let server, browser, failure;
  const abort = () => {
    failure ??= new Error('Cold navigation interrupted');
    for (const child of [browser, server]) if (child?.pid && groupAlive(child)) process.kill(-child.pid, 'SIGTERM');
  };
  process.on('SIGTERM', abort);
  process.on('SIGINT', abort);
  try {
    server = start(
      [resolve(ROOT, 'apps/web/.next/standalone/apps/web/server.js')],
      { ...env, PORT: '3002', HOSTNAME: '127.0.0.1' },
      process.execPath
    );
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch('http://127.0.0.1:3002/login', { signal: AbortSignal.timeout(2000) });
        await response.body?.cancel();
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {}
      await delay(250);
    }
    assert(ready, 'Production cold-navigation server did not become ready');
    browser = start(
      [
        '--dir',
        'apps/web',
        'exec',
        'playwright',
        'test',
        'tests/production-cold-navigation.spec.ts',
        '--workers=1',
        '--reporter=line',
      ],
      { ...env, PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:3002', PLAYWRIGHT_PRODUCTION_SMOKE: '1' }
    );
    await Promise.race([
      browser.result,
      server.result.then(() => {
        throw new Error('Cold server exited during tests');
      }),
    ]);
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Cold navigation interrupted and command failed') : error;
  } finally {
    for (const child of [browser, server]) {
      try {
        await stop(child);
      } catch (error) {
        failure = failure ? new AggregateError([failure, error], 'Cold navigation and cleanup failed') : error;
      }
    }
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
    try {
      await assertClosed([3002]);
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Cold navigation port cleanup failed') : error;
    }
  }
  if (failure) throw failure;
}

async function main() {
  assert.notEqual(process.platform, 'win32', 'POSIX-owned process groups required');
  const ports = emulatorPorts(JSON.parse(await readFile(resolve(ROOT, 'firebase.test.json'), 'utf8')));
  // Next loads local dotenv files itself. Refuse them instead of silently importing credentials.
  for (const folder of [ROOT, resolve(ROOT, 'apps/web')]) {
    assert(!(await readdir(folder)).some(isLoadedDotenv), 'Clean CI checkout without dotenv files required');
  }
  const env = isolatedEnvironment(process.env, ports);
  if (process.argv.includes('--build-production')) {
    await buildProduction(env);
    return;
  }
  await verifyProductionBuild(ROOT, env);
  if (process.argv.includes('--verify-production')) return;
  if (process.argv.includes('--cold-navigation')) return coldNavigation(env);
  let child;
  let failure;
  let stopping = false;
  let fixtureDirectory;
  const abort = () => {
    failure ??= new Error('Authenticated browser check interrupted');
    if (child?.pid && groupAlive(child)) process.kill(-child.pid, 'SIGTERM');
  };
  process.on('SIGTERM', abort);
  process.on('SIGINT', abort);
  try {
    if (!process.argv.includes('--inside-emulators')) {
      await assertClosed([...Object.values(ports), 3004]);
      child = start(emulatorCommand(), env);
      await child.result;
    } else {
      validateEmulatorContext(process.env, ports);
      for (const key of Object.values(SERVICE_ENV)) env[key] = process.env[key];
      await assertClosed([3004]);
      const require = createRequire(resolve(ROOT, 'functions/package.json'));
      const { initializeApp, deleteApp } = require('firebase-admin/app');
      const { getAuth } = require('firebase-admin/auth');
      const { getFirestore } = require('firebase-admin/firestore');
      const { getDatabase } = require('firebase-admin/database');
      const app = initializeApp(
        { projectId: PROJECT, databaseURL: JSON.parse(env.FIREBASE_CONFIG).databaseURL },
        'ci-player-seed'
      );
      const db = getFirestore(app);
      const database = getDatabase(app);
      let seedError;
      try {
        const auth = getAuth(app);
        await seedMediaAdmin(auth);
        const source = loadMediaFixtureSources(require);
        const fixture = await buildMediaBackendFixture({ db, auth, database, ...source });
        const json = JSON.stringify(fixture);
        // Validate the same serialized handoff the Playwright fixture will read before starting any browser.
        source.parseMediaBackendFixture(JSON.parse(json));
        assert(Buffer.byteLength(json) <= 8 * 1024 * 1024, 'Media fixtures exceed budget');
        fixtureDirectory = await mkdtemp(resolve(tmpdir(), 'urm-media-browser-'));
        env.URM_MEDIA_BROWSER_BUNDLE_FIXTURES_FILE = resolve(fixtureDirectory, 'fixtures.json');
        await writeFile(env.URM_MEDIA_BROWSER_BUNDLE_FIXTURES_FILE, json, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        seedError = error;
      } finally {
        await cleanupMediaSeed(db, database, app, deleteApp, seedError);
      }
      await verifyProductionBuild(ROOT, env);
      child = start(
        [resolve(ROOT, 'apps/web/.next/standalone/apps/web/server.js')],
        { ...env, PORT: '3004', HOSTNAME: '127.0.0.1' },
        process.execPath
      );
      const ready = async () => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          if (failure || stopping) throw failure ?? new Error('Readiness cancelled');
          try {
            const response = await fetch(`${env.PLAYWRIGHT_BASE_URL}/login`, { signal: AbortSignal.timeout(2000) });
            await response.body?.cancel();
            if (response.ok) return;
          } catch {}
          await delay(500);
        }
        throw new Error('Owned Next login did not become ready');
      };
      await Promise.race([
        ready(),
        child.result.then(() => {
          throw new Error('Next exited before tests');
        }),
      ]);
      const browser = start(
        [
          '--dir',
          'apps/web',
          'exec',
          'playwright',
          'test',
          ...SPECS,
          '--workers=1',
          '--reporter=line',
          '--trace=retain-on-failure',
        ],
        env
      );
      try {
        await Promise.race([
          browser.result,
          child.result.then(() => {
            throw new Error('Next exited during tests');
          }),
        ]);
      } finally {
        await stop(browser);
      }
    }
  } catch (error) {
    failure ??= error;
  } finally {
    stopping = true;
    try {
      await stop(child);
      await assertClosed(process.argv.includes('--inside-emulators') ? [3004] : [...Object.values(ports), 3004]);
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Checks and cleanup failed') : error;
    }
    if (fixtureDirectory) {
      try {
        await rm(fixtureDirectory, { recursive: true, force: true });
      } catch (error) {
        failure = failure ? new AggregateError([failure, error], 'Checks and fixture cleanup failed') : error;
      }
    }
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
  }
  if (failure) throw failure;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
