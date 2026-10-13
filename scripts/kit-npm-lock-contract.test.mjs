import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deployedKitSources, validateKitNpmLock, validateSharpPlatformClosure } from './kit-npm-lock-contract.mjs';
const root = new URL('..', import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, root), 'utf8'));
test('every deployable kit manifest has an integrity-pinned full-platform npm lock', () => {
  for (const source of deployedKitSources(read('firebase.json')))
    validateKitNpmLock(read(source + '/package.json'), read(source + '/package-lock.json'));
});
test('the exact old Darwin-only Sharp lock fails before any deployment', () => {
  assert.throws(
    () => validateSharpPlatformClosure(read('scripts/tests/fixtures/image-kit-darwin-lock.json')),
    /Sharp optional platform package missing/
  );
});
test('native Linux bindings, libvips and their exact versions cannot be dropped or replaced', () => {
  for (const name of ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64']) {
    const lock = read('function-kits/image-processing-api/source/package-lock.json');
    delete lock.packages['node_modules/' + name];
    assert.throws(() => validateSharpPlatformClosure(lock), /missing/);
    const changed = read('function-kits/image-processing-api/source/package-lock.json');
    changed.packages['node_modules/' + name].version = '0.0.0';
    assert.throws(() => validateSharpPlatformClosure(changed), /inconsistent/);
  }
});
test('manifest drift, workspace links and missing integrity are rejected for kit locks', () => {
  const source = 'function-kits/firestore-algolia-search',
    manifest = read(source + '/package.json'),
    lock = read(source + '/package-lock.json');
  const changed = structuredClone(lock);
  changed.packages[''].dependencies.algoliasearch = '0.0.0';
  assert.throws(() => validateKitNpmLock(manifest, changed), /manifest mismatch/);
  const missing = structuredClone(lock);
  delete missing.packages['node_modules/algoliasearch'].integrity;
  assert.throws(() => validateKitNpmLock(manifest, missing), /integrity-pinned/);
});

test('Linux native package metadata must target x64 glibc Linux', () => {
  for (const field of ['os', 'cpu', 'libc']) {
    const lock = read('function-kits/image-processing-api/source/package-lock.json');
    lock.packages['node_modules/@img/sharp-linux-x64'][field] = ['wrong'];
    assert.throws(() => validateSharpPlatformClosure(lock), /wrong platform metadata/);
  }
});
