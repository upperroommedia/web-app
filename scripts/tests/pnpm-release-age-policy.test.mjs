import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const videoPackages = ['core', 'media', 'native-hls-video', 'react', 'spf', 'store', 'utils'].map(
  (name) => `@videojs/${name}`
);

test('native pnpm enforces release age without silently adding exceptions', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'urm-release-age-'));
  const requests = [];
  const published = new Date().toISOString();
  const registry = createServer((request, response) => {
    const name = decodeURIComponent(request.url.slice(1));
    requests.push(name);
    if (name.endsWith('.tgz')) {
      response.writeHead(500).end('Tarball downloads are forbidden in this lock-only fixture');
      return;
    }
    const version = name.startsWith('@videojs/') ? '10.1.0' : '1.0.0';
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      name,
      'dist-tags': { latest: version },
      versions: { [version]: { name, version, dist: {
        tarball: `http://127.0.0.1:${registry.address().port}/forbidden.tgz`,
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      } } },
      time: { created: '2020-01-01T00:00:00.000Z', modified: published, [version]: published },
    }));
  });
  try {
    await new Promise((resolve, reject) => {
      registry.once('error', reject);
      registry.listen(0, '127.0.0.1', resolve);
    });
    await writeFile(path.join(directory, 'empty.npmrc'), '');
    const env = {
      PATH: process.env.PATH,
      CI: 'true',
      NPM_CONFIG_USERCONFIG: path.join(directory, 'empty.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: path.join(directory, 'empty.npmrc'),
      XDG_CONFIG_HOME: path.join(directory, 'config'),
      XDG_CACHE_HOME: path.join(directory, 'cache'),
      XDG_DATA_HOME: path.join(directory, 'data'),
      GOOGLE_APPLICATION_CREDENTIALS: path.join(directory, 'nonexistent-adc'),
    };
    const executable = process.env.URM_POLICY_PNPM_BINARY || process.env.npm_execpath || 'pnpm';
    const prefix = /\.[cm]?js$/.test(executable) ? [executable] : [];
    const binary = prefix.length ? process.execPath : executable;
    const run = (args, cwd) => exec(binary, [...prefix, ...args], {
      cwd, env, timeout: 25000, maxBuffer: 64 * 1024,
    });
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal((await run(['--version'], directory)).stdout.trim(), manifest.packageManager.replace('pnpm@', ''));
    const workspace = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(workspace, /^minimumReleaseAgeStrict: true$/m);
    const exclusions = workspace.match(/^minimumReleaseAgeExclude:\n((?:[ \t].*\n)*)/m)?.[1];
    assert.ok(exclusions, 'Use the real workspace exclusions in the policy fixture');
    for (const name of videoPackages) assert.ok(exclusions.includes(`'${name}@10.1.0'`));
    for (const [name, strict, dependencies, approved] of [
      ['strict-unapproved', true, { 'urm-fresh-fixture': '1.0.0' }, false],
      ['loose-positive', false, { 'urm-fresh-fixture': '1.0.0' }, false],
      ['strict-approved-seven', true, Object.fromEntries(videoPackages.map((name) => [name, '10.1.0'])), true],
    ]) {
      const cwd = path.join(directory, name);
      await mkdir(cwd);
      await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name, private: true, dependencies }));
      const configuration = `packages: []\nminimumReleaseAgeStrict: ${strict}\n${approved ? `minimumReleaseAgeExclude:\n${exclusions}` : ''}`;
      const yaml = path.join(cwd, 'pnpm-workspace.yaml');
      await writeFile(yaml, configuration);
      const command = ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile',
        '--registry', `http://127.0.0.1:${registry.address().port}`, '--store-dir', path.join(directory, `store-${name}`),
        '--state-dir', path.join(directory, `state-${name}`), '--npmrc-auth-file', path.join(directory, 'empty.npmrc')];
      if (strict && !approved) {
        await assert.rejects(run(command, cwd), (error) => {
          assert.notEqual(error.code, 0);
          assert.match(error.stderr, /ERR_PNPM_NO_MATURE_MATCHING_VERSION/);
          return true;
        });
      } else {
        await run(command, cwd);
        await access(path.join(cwd, 'pnpm-lock.yaml'));
      }
      const after = await readFile(yaml, 'utf8');
      if (strict) assert.equal(after, configuration, 'Strict resolution must not mutate policy');
      else assert.match(after, /urm-fresh-fixture@1\.0\.0/, 'Positive control must reproduce automatic exception creation');
      await assert.rejects(access(path.join(cwd, 'node_modules')), { code: 'ENOENT' });
    }
    assert.ok(requests.includes('urm-fresh-fixture'));
    for (const name of videoPackages) assert.ok(requests.includes(name));
    assert.equal(requests.some((name) => name.endsWith('.tgz')), false);
  } finally {
    await new Promise((resolve) => registry.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
