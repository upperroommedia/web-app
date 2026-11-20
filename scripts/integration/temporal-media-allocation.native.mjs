import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, realpath, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(new URL('../../package.json', import.meta.url));
require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const { allocateMediaCapacity, MEDIA_ALLOCATION_PROGRAM_SHA256 } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/media-capacity-allocation.ts', import.meta.url)
));
for (const mode of ['small-native', 'pre-aborted', 'wrong-tool'])
  test(`native allocation child/owned cleanup / ${mode}`, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'urm-small-allocation-')));
    let allocation;
    try {
      const controller = new AbortController();
      if (mode === 'pre-aborted') controller.abort();
      const promise = allocateMediaCapacity(controller.signal, {
        directory,
        bytes: 1024 ** 2,
        python: mode === 'wrong-tool' ? process.execPath : '/usr/bin/python3',
      });
      if (mode !== 'small-native' || process.platform !== 'linux') {
        // macOS Python does not provide posix_fallocate. Denial, never a sparse fallback.
        await assert.rejects(promise);
      } else {
        allocation = await promise;
        await allocation.assertHeld();
        const proof = await allocation.release();
        allocation = undefined;
        assert.equal(proof.requestedBytes, 1024 ** 2);
        assert.ok(proof.allocatedBytes >= 1024 ** 2);
        assert.equal(proof.programSHA256, MEDIA_ALLOCATION_PROGRAM_SHA256);
        assert.equal(proof.cleanupConfirmed, true);
      }
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await allocation?.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });

test('aborted owned allocator child settles before sparse test file cleanup', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'urm-allocation-cancel-')));
  const { writeFile, readFile } = await import('node:fs/promises');
  const wrapper = join(directory, 'controlled-python'),
    marker = join(directory, 'pid');
  let pid, observed;
  const controller = new AbortController();
  try {
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s' "$$" > '${marker}'\nexec /bin/sleep 30\n`, { mode: 0o700 });
    const work = allocateMediaCapacity(controller.signal, { directory, bytes: 1024 ** 2, python: wrapper });
    observed = work.catch((e) => e);
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      try {
        pid = Number(await readFile(marker, 'utf8'));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    assert.ok(Number.isSafeInteger(pid) && pid > 1, 'owned child started');
    controller.abort();
    assert.ok((await observed) instanceof Error);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.deepEqual((await readdir(directory)).sort(), ['controlled-python', 'pid']);
  } finally {
    controller.abort();
    await observed;
    await rm(directory, { recursive: true, force: true });
  }
});
