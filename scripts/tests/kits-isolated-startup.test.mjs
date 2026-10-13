import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, Socket } from 'node:net';
import { request } from 'node:http';
import { deployedKitSources, validateKitNpmLock } from '../kit-npm-lock-contract.mjs';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sources = deployedKitSources(JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8')));
const temporary = mkdtempSync(join(tmpdir(), 'urm-kit-linux-startup-'));
const cache = join(temporary, 'npm-cache'),
  framework = join(temporary, 'framework');
mkdirSync(cache);
mkdirSync(framework);
const emptyUserConfig = join(temporary, 'empty-user.npmrc'),
  emptyGlobalConfig = join(temporary, 'empty-global.npmrc');
writeFileSync(emptyUserConfig, '');
writeFileSync(emptyGlobalConfig, '');
after(() => rmSync(temporary, { recursive: true, force: true }));
const npmEnv = (mode) => ({
  PATH: process.env.PATH,
  TMPDIR: temporary,
  CI: 'true',
  NODE_ENV: mode,
  NPM_CONFIG_USERCONFIG: emptyUserConfig,
  NPM_CONFIG_GLOBALCONFIG: emptyGlobalConfig,
});
function npm(directory, mode) {
  execFileSync(
    'npm',
    [
      'ci',
      ...(mode === 'production' ? ['--omit=dev'] : []),
      '--include=optional',
      '--ignore-scripts=false',
      '--no-audit',
      '--no-fund',
      '--cache',
      cache,
    ],
    { cwd: directory, env: npmEnv(mode), stdio: 'pipe', timeout: 180000, maxBuffer: 4 * 1024 * 1024 }
  );
}
function copyLockedPackage(source, target) {
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(source, file), join(target, file));
  validateKitNpmLock(
    JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')),
    JSON.parse(readFileSync(join(target, 'package-lock.json'), 'utf8'))
  );
}
let layerInstalled = false;
async function freePort() {
  const server = createServer();
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  const port = server.address().port;
  await new Promise((accept) => server.close(accept));
  return port;
}
async function waitPort(port, child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error('Functions framework exited before binding its port');
    if (
      await new Promise((accept) => {
        const socket = new Socket();
        socket.once('connect', () => {
          socket.destroy();
          accept(true);
        });
        socket.once('error', () => {
          socket.destroy();
          accept(false);
        });
        socket.connect(port, '127.0.0.1');
      })
    )
      return;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw Error('Functions framework did not bind its port');
}
function getImage(port) {
  const operations = [
    { operation: 'input', type: 'create', width: 7, height: 5, background: '#cc6644' },
    { operation: 'output', format: 'png' },
  ];
  return new Promise((accept, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/process?operations=' + encodeURIComponent(JSON.stringify(operations)) },
      (res) => {
        const data = [];
        res.on('data', (chunk) => data.push(chunk));
        res.on('end', () => accept({ status: res.statusCode, headers: res.headers, data: Buffer.concat(data) }));
      }
    );
    req.once('error', reject);
    req.end();
  });
}
for (const source of sources) {
  test(
    `${source} starts its actual Cloud Functions entrypoint with locked Linux-native production dependencies`,
    { timeout: 360000 },
    async () => {
      if (process.env.KIT_STARTUP_REQUIRE_LINUX_X64 === 'true') {
        assert.equal(process.platform, 'linux');
        assert.equal(process.arch, 'x64');
      }
      assert.equal(process.versions.node.split('.')[0], '22');
      if (!layerInstalled) {
        copyLockedPackage(join(root, 'scripts/tests/fixtures/functions-framework'), framework);
        npm(framework, 'production');
        layerInstalled = true;
      }
      const directory = join(temporary, source.replaceAll('/', '-'));
      mkdirSync(directory);
      let child,
        output = '';
      try {
        copyLockedPackage(join(root, source), directory);
        cpSync(join(root, source, 'src'), join(directory, 'src'), { recursive: true });
        cpSync(join(root, source, 'tsconfig.json'), join(directory, 'tsconfig.json'));
        npm(directory, 'development');
        execFileSync('npm', ['run', 'build'], {
          cwd: directory,
          env: npmEnv('development'),
          stdio: 'pipe',
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const lockBytes = readFileSync(join(directory, 'package-lock.json'));
        npm(directory, 'production');
        assert.ok(readFileSync(join(directory, 'package-lock.json')).equals(lockBytes));
        const lock = JSON.parse(lockBytes);
        for (const [location, entry] of Object.entries(lock.packages))
          if (location && entry.dev === true)
            assert.equal(
              existsSync(join(directory, location)),
              false,
              `Development-only dependency installed: ${location}`
            );
        const image = source.includes('image-processing-api'),
          target = image ? 'handler' : source.includes('send-email') ? 'processQueue' : 'executeIndexOperation';
        const port = await freePort(),
          proofPath = join(directory, 'startup-proof.json');
        child = spawn(
          process.execPath,
          [
            '--no-global-search-paths',
            '--require',
            join(root, 'scripts/tests/fixtures/kit-runtime-preload.cjs'),
            join(framework, 'node_modules/@google-cloud/functions-framework/build/src/main.js'),
            '--source',
            directory,
            '--target',
            target,
            '--signature-type',
            image ? 'http' : 'cloudevent',
          ],
          {
            cwd: directory,
            env: {
              PATH: process.env.PATH,
              TMPDIR: temporary,
              NODE_ENV: 'production',
              PORT: String(port),
              KIT_DEPLOYMENT_ROOT: directory,
              KIT_FRAMEWORK_ROOT: framework,
              KIT_STARTUP_PROOF: proofPath,
              GCLOUD_PROJECT: 'demo-kit-startup',
              FIREBASE_CONFIG: JSON.stringify({
                projectId: 'demo-kit-startup',
                storageBucket: 'demo-kit-startup.appspot.com',
                databaseURL: 'https://demo-kit-startup-default-rtdb.firebaseio.com',
              }),
              CLOUD_STORAGE_BUCKET: 'demo-kit-startup-images',
              CORS_ORIGIN_ALLOW_LIST: '*',
              HOSTNAME: 'example.invalid',
              MAIL_COLLECTION: 'mail-fixture',
              SMTP_CONNECTION_URI: 'smtp://example.invalid:2525',
              DEFAULT_FROM: 'fixture@example.invalid',
              COLLECTION_PATH: 'images-fixture',
              ALGOLIA_APP_ID: 'fixture',
              ALGOLIA_INDEX_NAME: 'fixture',
              AUTH_TYPE: 'UsernamePassword',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        child.stdout.on('data', (data) => (output += data));
        child.stderr.on('data', (data) => (output += data));
        await waitPort(port, child);
        if (image) {
          const response = await getImage(port);
          assert.equal(response.status, 200, output);
          assert.equal(response.headers['content-type'], 'image/png');
          assert.equal(response.headers['ext-output-info-width'], '7');
          assert.equal(response.headers['ext-output-info-height'], '5');
          assert.equal(response.headers['cache-control'], 'public, max-age=3600, s-maxage=86400');
          assert.ok(response.data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
        }
        await new Promise((accept) => {
          child.once('exit', accept);
          child.kill('SIGTERM');
        });
        const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
        assert.equal(proof.externalNetworkAttempts, 0, output);
        if (image && process.platform === 'linux' && process.arch === 'x64')
          assert.equal(proof.nativeSharpLinuxX64, true, 'WASM fallback is not Linux native startup proof');
        console.log(
          JSON.stringify({
            source,
            node: process.versions.node,
            platform: process.platform,
            arch: process.arch,
            framework: '3.5.1',
            productionInstall: 'npm ci --omit=dev --ignore-scripts=false',
            tcpStartup: true,
            imageHttp: image,
            proof,
          })
        );
        if (image && process.platform === 'linux' && process.arch === 'x64') {
          rmSync(join(directory, 'node_modules'), { recursive: true, force: true });
          cpSync(join(root, 'scripts/tests/fixtures/image-kit-darwin-lock.json'), join(directory, 'package-lock.json'));
          npm(directory, 'production');
          assert.throws(
            () =>
              execFileSync(process.execPath, ['--no-global-search-paths', '-e', "require('./lib/index.js')"], {
                cwd: directory,
                env: {
                  PATH: process.env.PATH,
                  NODE_ENV: 'production',
                  CLOUD_STORAGE_BUCKET: 'demo-kit-startup-images',
                  CORS_ORIGIN_ALLOW_LIST: '*',
                },
                stdio: 'pipe',
                timeout: 30000,
              }),
            (error) =>
              /Could not load the \"sharp\" module using the linux-x64 runtime/.test(error.stderr?.toString() ?? ''),
            'The original Darwin-only upload must fail actual Linux native startup'
          );
          console.log('Verified original Darwin-only lock fails actual Linux image entrypoint');
        }
      } catch (error) {
        error.message += '\n' + output;
        throw error;
      } finally {
        if (child && child.exitCode === null) child.kill('SIGKILL');
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
}
