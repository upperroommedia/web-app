import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNativeReleaseApplication } from './temporal-native-application.mjs';
const root = fileURLToPath(new URL('..', import.meta.url)),
  key = Symbol.for('ts-node.register.instance');
test('repeated guarded runtime application loads release their own disabled compiler ownership', () => {
  let owned;
  try {
    const first = loadNativeReleaseApplication(root);
    owned = process[key];
    const second = loadNativeReleaseApplication(root);
    assert.equal(typeof first.collectRestoredMediaStartup, 'function');
    for (const method of [
      'collectMediaPromotionStartup',
      'collectMediaPromotionRecoveryExecution',
      'confirmMediaPromotionRecoveryProvenance',
    ])
      assert.equal(typeof first[method], 'function');
    assert.equal(typeof first.Client, 'function');
    assert.equal(typeof second.collectServerlessRoleReadiness, 'function');
    assert.equal(process[key], undefined);
  } finally {
    if (owned && process[key] === owned) {
      owned.enabled(false);
      delete process[key];
    }
  }
});
for (const enabled of [true, false])
  test(`a foreign compiler remains denied and untouched / enabled ${enabled}`, () => {
    const require = createRequire(new URL('../package.json', import.meta.url));
    const foreign = require('ts-node').register({
      skipProject: true,
      transpileOnly: true,
      compilerOptions: { module: 'CommonJS', target: 'ES2022' },
    });
    foreign.enabled(enabled);
    try {
      assert.throws(() => loadNativeReleaseApplication(root), /RELEASE_COMPILER_ALREADY_ACTIVE/);
      assert.equal(process[key], foreign);
      assert.equal(foreign.enabled(), enabled);
    } finally {
      foreign.enabled(false);
      if (process[key] === foreign) delete process[key];
    }
  });
test('a failed owned application import also releases only its own compiler', () => {
  const directory = mkdtempSync(join(tmpdir(), 'urm-native-compiler-'));
  try {
    writeFileSync(join(directory, 'package.json'), '{}');
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    mkdirSync(join(directory, 'apps/temporal-worker'), { recursive: true });
    writeFileSync(join(directory, 'apps/temporal-worker/package.json'), '{}');
    assert.throws(() => loadNativeReleaseApplication(directory), { code: 'MODULE_NOT_FOUND' });
    assert.equal(process[key], undefined);
    assert.equal(typeof loadNativeReleaseApplication(root).Client, 'function');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
