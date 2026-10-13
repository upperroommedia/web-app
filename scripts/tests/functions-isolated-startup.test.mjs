import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  mkdtempSync,
  rmSync,
  renameSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire, isBuiltin } from 'node:module';
import { materializedPackageContents } from '../materialize-catalog-for-firebase.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const ts = createRequire(join(root, 'functions/package.json'))('typescript');
const npmCache = mkdtempSync(join(tmpdir(), 'urm-functions-npm-cache-'));
after(() => rmSync(npmCache, { recursive: true, force: true }));
const packageName = (name) => (name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]);

// Follow emitted runtime imports, including literal dynamic imports. A declaration
// check prevents a hoisted transitive package from concealing a missing direct dependency.
function runtimeClosure(entry) {
  const visited = new Set(),
    external = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    function inspect(node) {
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        assert.ok(
          argument && ts.isStringLiteralLike(argument),
          `Nonliteral runtime import needs explicit coverage: ${file}`
        );
        const name = argument.text;
        if (!isBuiltin(name)) {
          if (name.startsWith('.') || isAbsolute(name)) {
            const target = createRequire(file).resolve(name);
            if (target.endsWith('.js')) visit(target);
          } else external.add(name);
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  visit(entry);
  return external;
}

const childProgram = String.raw`
const path = require('node:path');
const Module = require('node:module');
const fs = require('node:fs');
const root = fs.realpathSync(process.cwd());
const inside = file => file === root || file.startsWith(root + path.sep);
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(name, ...args) {
  const target = originalResolve.call(this, name, ...args);
  if (!Module.isBuiltin(name) && typeof target === 'string' && !inside(fs.realpathSync(target))) {
    throw Error('Dependency escaped isolated deployment: ' + name);
  }
  return target;
};
let networkAttempts = 0;
const denyNetwork = () => { networkAttempts++; throw Error('Startup attempted network access'); };
for (const name of ['node:http', 'node:https']) {
  const client = require(name); client.request = denyNetwork; client.get = denyNetwork;
}
require('node:net').Socket.prototype.connect = denyNetwork;
global.fetch = denyNetwork;
(async () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const exports = require(path.resolve(pkg.main));
  const endpoints = Object.entries(exports).filter(([,value]) => typeof value === 'function' && value.__endpoint).map(([key]) => key);
  if (!endpoints.length) throw Error('No Firebase endpoints discovered');
  const imagePackages = ['sharp', 'node-vibrant', 'fast-average-color-node'];
  if (pkg.name === 'functions-core') {
    const loaded = Object.keys(require.cache);
    for (const name of imagePackages) if (loaded.some(file => file.includes(path.sep + 'node_modules' + path.sep + name + path.sep))) throw Error('Core cold startup loaded image processing package: ' + name);
  }
  if (process.env.IMAGE_METADATA_PROBE === 'true') {
    const sharp = require('sharp');
    const buffer = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#aa4422' } }).png().toBuffer();
    const compute = require('./lib/functions/src/computeMetadataForImage.js').default;
    const metadata = await compute(buffer);
    if (metadata.width !== 3 || metadata.height !== 2 || !metadata.averageColorHex || !metadata.vibrantColorHex) throw Error('Image metadata runtime probe failed');
  }
  if (networkAttempts) throw Error('Network calls attempted during startup');
  console.log('ISOLATED_STARTUP_PROOF=' + JSON.stringify({ endpoints, networkAttempts }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
function startup(directory, imageProbe = false) {
  // Do not inherit provider credentials, emulator addresses, NODE_PATH or worker settings.
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    HOME: directory,
    TMPDIR: tmpdir(),
    GCLOUD_PROJECT: 'demo-isolated-functions',
    FIREBASE_PROJECT_ID: 'demo-isolated-functions',
    FIREBASE_CONFIG: JSON.stringify({
      projectId: 'demo-isolated-functions',
      storageBucket: 'demo-isolated-functions.appspot.com',
      databaseURL: 'https://demo-isolated-functions-default-rtdb.firebaseio.com',
    }),
    IMAGE_METADATA_PROBE: String(imageProbe),
    SENTRY_ENABLE_LOGS: 'false',
    SENTRY_TRACES_SAMPLE_RATE: '0',
  };
  return spawnSync(process.execPath, ['--no-global-search-paths', '-e', childProgram], {
    cwd: directory,
    env,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function installProduction(directory) {
  return execFileSync(
    'npm',
    ['ci', '--omit=dev', '--ignore-scripts=false', '--no-audit', '--no-fund', '--cache', npmCache],
    {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: npmCache, TMPDIR: tmpdir(), CI: 'true', NODE_ENV: 'production' },
      stdio: 'pipe',
      timeout: 300000,
      maxBuffer: 4 * 1024 * 1024,
    }
  );
}

test(
  'production installer executes lifecycle scripts under production without inherited credentials',
  { timeout: 30000 },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'urm-functions-lifecycle-'));
    const previousPrivateFixture = process.env.FUNCTIONS_INSTALL_PRIVATE_FIXTURE;
    process.env.FUNCTIONS_INSTALL_PRIVATE_FIXTURE = 'synthetic-test-data';
    try {
      const install =
        "const fs=require('node:fs'); if(process.env.NODE_ENV!=='production')throw Error('Expected production'); if(process.env.FUNCTIONS_INSTALL_PRIVATE_FIXTURE)throw Error('Inherited private environment'); fs.writeFileSync('lifecycle-proof','executed')";
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'isolated-lifecycle-fixture',
          version: '1.0.0',
          private: true,
          scripts: { install: 'node lifecycle.cjs' },
        })
      );
      writeFileSync(join(directory, 'lifecycle.cjs'), install);
      execFileSync(
        'npm',
        ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCache],
        { cwd: directory, stdio: 'pipe', timeout: 20000, env: { PATH: process.env.PATH, HOME: npmCache } }
      );
      assert.equal(existsSync(join(directory, 'lifecycle-proof')), false);
      installProduction(directory);
      assert.equal(readFileSync(join(directory, 'lifecycle-proof'), 'utf8'), 'executed');
    } finally {
      if (previousPrivateFixture === undefined) delete process.env.FUNCTIONS_INSTALL_PRIVATE_FIXTURE;
      else process.env.FUNCTIONS_INSTALL_PRIVATE_FIXTURE = previousPrivateFixture;
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

for (const codebase of ['core', 'media', 'image', 'integrations']) {
  test(
    `${codebase} declares its entire runtime closure and starts with actual locked npm production deployment dependencies`,
    { timeout: 360000 },
    () => {
      const source = join(root, `functions-${codebase}`),
        original = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
      const entry = join(source, original.main);
      assert.ok(existsSync(entry), 'Build split Functions codebases before this check');
      const external = runtimeClosure(entry);
      for (const name of external)
        assert.ok(
          original.dependencies[packageName(name)],
          `${codebase} runtime import ${name} is absent from production dependencies`
        );
      const temporary = mkdtempSync(join(tmpdir(), `urm-functions-${codebase}-startup-`)),
        directory = join(temporary, 'deployment');
      try {
        mkdirSync(directory);
        const manifest = materializedPackageContents(
          readFileSync(join(source, 'package.json'), 'utf8'),
          readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
        );
        writeFileSync(join(directory, 'package.json'), manifest);
        cpSync(join(source, 'package-lock.json'), join(directory, 'package-lock.json'));
        cpSync(join(source, 'lib'), join(directory, 'lib'), { recursive: true });
        const lockBytes = readFileSync(join(directory, 'package-lock.json'));
        const lock = JSON.parse(lockBytes);
        assert.equal(lock.lockfileVersion, 3, 'Use the committed npm production artifact');
        const deployed = JSON.parse(manifest);
        assert.equal(deployed.main, original.main);
        // Match the Cloud Functions buildpack: npm ci with production omission and
        // dependency lifecycle scripts enabled, rather than pnpm's workspace graph.
        installProduction(directory);
        assert.ok(
          readFileSync(join(directory, 'package-lock.json')).equals(lockBytes),
          'npm ci must not rewrite the reviewed graph'
        );
        for (const [location, metadata] of Object.entries(lock.packages)) {
          if (location && metadata.dev === true)
            assert.equal(
              existsSync(join(directory, location)),
              false,
              `Development-only dependency installed: ${location}`
            );
        }
        for (const name of external) {
          assert.ok(deployed.dependencies[packageName(name)]);
          const resolved = realpathSync(createRequire(join(directory, 'package.json')).resolve(name));
          assert.ok(
            resolved.startsWith(realpathSync(directory) + '/'),
            `Resolution escaped exported dependencies: ${name}`
          );
        }
        const result = startup(directory, codebase === 'core' || codebase === 'image');
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const proof = JSON.parse(result.stdout.match(/ISOLATED_STARTUP_PROOF=(.*)/)[1]);
        assert.equal(proof.networkAttempts, 0);
        assert.ok(proof.endpoints.length > 0);
        if (codebase === 'core') {
          const dependency = join(directory, 'node_modules/fast-average-color-node');
          renameSync(dependency, dependency + '.missing');
          const missing = startup(directory, true);
          assert.notEqual(missing.status, 0, 'Missing image dependency must fail the actual runtime operation');
          assert.match(missing.stderr, /Cannot find module 'fast-average-color-node'/);
        }
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  );
}
