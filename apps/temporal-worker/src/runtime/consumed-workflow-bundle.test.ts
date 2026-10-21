import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readStableBundleBytes,
  loadConsumedWorkflowBundle,
  consumeWorkflowBundleBytes,
} from './consumed-workflow-bundle';

test('actual owned descriptor returns stable exact bytes that remain unchanged after path contents change', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'consumed-bundle-')));
  try {
    const path = join(directory, 'bundle.js');
    await writeFile(path, 'original bundle bytes', { mode: 0o600 });
    const bytes = await readStableBundleBytes(path, 1024);
    await writeFile(path, 'replacement path bytes');
    expect(bytes.toString()).toBe('original bundle bytes');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
for (const mode of ['empty', 'size', 'writable', 'symlink'])
  test(`bundle read denies ${mode}`, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'consumed-bundle-')));
    try {
      let path = join(directory, 'bundle.js');
      await writeFile(path, mode === 'empty' ? '' : 'bundle', { mode: 0o600 });
      if (mode === 'writable') await chmod(path, 0o666);
      if (mode === 'symlink') {
        await symlink(path, join(directory, 'alias'));
        path = join(directory, 'alias');
      }
      await expect(readStableBundleBytes(path, mode === 'size' ? 1 : 1024)).rejects.toThrow(
        'IMAGE_WORKFLOW_BUNDLE_UNCONFIRMED'
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
test('Cloud Run loader has no arbitrary path or invalid build fallback', async () => {
  await expect(loadConsumedWorkflowBundle('/tmp/operator-code.js', 'a'.repeat(40))).rejects.toThrow(
    'IMAGE_WORKFLOW_BUNDLE_UNCONFIRMED'
  );
  await expect(
    loadConsumedWorkflowBundle('/workspace/apps/temporal-worker/lib/workflow-bundle.js', 'bad')
  ).rejects.toThrow('IMAGE_WORKFLOW_BUNDLE_UNCONFIRMED');
});

test('held UTF-8 bytes including BOM are exactly the code supplied to the worker', () => {
  const bytes = Buffer.from('\ufeffconst value = "λ";');
  const held = consumeWorkflowBundleBytes(bytes, 'a'.repeat(40));
  expect(Buffer.from(held.code, 'utf8')).toEqual(bytes);
  expect(held.evidence.bundleBytes).toBe(bytes.length);
  expect(() => consumeWorkflowBundleBytes(Buffer.from([0xff]), 'a'.repeat(40))).toThrow(
    'IMAGE_WORKFLOW_BUNDLE_UNCONFIRMED'
  );
});
