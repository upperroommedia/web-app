// CI-only authenticated UI checks. Never loads a real project or credential file.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
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
    GCLOUD_PROJECT: PROJECT,
    GOOGLE_CLOUD_PROJECT: PROJECT,
    FIREBASE_PROJECT_ID: PROJECT,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: PROJECT,
    NEXT_PUBLIC_FIREBASE_API_KEY: 'synthetic-public-browser-test-key',
    NEXT_PUBLIC_FIREBASE_APP_ID: '1:123456789:web:synthetic',
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
  return env;
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

function start(args, env) {
  const child = spawn('pnpm', args, { cwd: ROOT, env, detached: true, stdio: 'inherit' });
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
async function main() {
  assert.notEqual(process.platform, 'win32', 'POSIX-owned process groups required');
  const ports = emulatorPorts(JSON.parse(await readFile(resolve(ROOT, 'firebase.test.json'), 'utf8')));
  // Next loads local dotenv files itself. Refuse them instead of silently importing credentials.
  for (const folder of [ROOT, resolve(ROOT, 'apps/web')]) {
    assert(!(await readdir(folder)).some(isLoadedDotenv), 'Clean CI checkout without dotenv files required');
  }
  const env = isolatedEnvironment(process.env, ports);
  let child;
  let failure;
  let stopping = false;
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
      const app = initializeApp({ projectId: PROJECT }, 'ci-player-seed');
      try {
        const auth = getAuth(app);
        await auth.createUser({
          uid: 'ci-player-admin',
          email: 'dev-admin@test.local',
          password: 'devadmin123',
          emailVerified: true,
        });
        await auth.setCustomUserClaims('ci-player-admin', { role: 'admin' });
      } finally {
        await deleteApp(app);
      }
      child = start(['--dir', 'apps/web', 'run', 'dev', '--hostname', '127.0.0.1', '--port', '3004'], env);
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
        ['--dir', 'apps/web', 'exec', 'playwright', 'test', ...SPECS, '--workers=1', '--reporter=line'],
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
