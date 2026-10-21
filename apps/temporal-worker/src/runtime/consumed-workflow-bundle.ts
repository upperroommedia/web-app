import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';

export interface ConsumedWorkflowBundleEvidence {
  schemaVersion: 1;
  buildId: string;
  bundleSHA256: string;
  bundleBytes: number;
}
const fail = (): never => {
  throw new Error('IMAGE_WORKFLOW_BUNDLE_UNCONFIRMED');
};
export const IMAGE_WORKFLOW_BUNDLE = '/workspace/apps/temporal-worker/lib/workflow-bundle.js';

/** Read one owned regular file through one descriptor; callers consume these exact bytes.
 * Exported for real filesystem tests. Production paths are fixed by the wrapper below.
 */
export async function readStableBundleBytes(path: string, maxBytes: number, rootOwned = false): Promise<Buffer> {
  let file;
  const deadline = Date.now() + 8000;
  try {
    if ((await realpath(path)) !== path || Date.now() >= deadline) fail();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > maxBytes ||
      before.mode & 0o022 ||
      (rootOwned ? before.uid !== 0 : ![0, process.getuid?.()].includes(before.uid))
    )
      fail();
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (Date.now() >= deadline) fail();
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await file.stat();
    if (
      size !== before.size ||
      Date.now() >= deadline ||
      (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const).some((key) => before[key] !== after[key])
    )
      fail();
    return bytes.subarray(0, size);
  } catch {
    return fail();
  } finally {
    try {
      await file?.close();
    } catch {
      fail();
    }
  }
}

export async function loadConsumedWorkflowBundle(path: string, buildId: string) {
  const deadline = Date.now() + 8000;
  try {
    if (path !== IMAGE_WORKFLOW_BUNDLE || !/^[a-f0-9]{40}$/.test(buildId)) fail();
    const baked = (await readStableBundleBytes('/etc/temporal-worker-build-id', 128, true)).toString('utf8').trim();
    if (baked !== buildId || Date.now() >= deadline) fail();
    const bytes = await readStableBundleBytes(path, 64 * 1024 * 1024);
    if (Date.now() >= deadline) fail();
    return consumeWorkflowBundleBytes(bytes, buildId);
  } catch {
    return fail();
  }
}

export function consumeWorkflowBundleBytes(bytes: Buffer, buildId: string) {
  try {
    const code = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const evidence: ConsumedWorkflowBundleEvidence = Object.freeze({
      schemaVersion: 1,
      buildId,
      bundleSHA256: createHash('sha256').update(bytes).digest('hex'),
      bundleBytes: bytes.length,
    });
    return Object.freeze({ code, evidence });
  } catch {
    return fail();
  }
}
