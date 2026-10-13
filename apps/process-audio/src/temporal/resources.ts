import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { ApplicationFailure } from '@temporalio/common';

const GiB = 1024 ** 3;
const bound = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
};
export const mediaResources = {
  sourceBytes: bound('TEMPORAL_MEDIA_MAX_SOURCE_BYTES', 20 * GiB),
  outputBytes: bound('TEMPORAL_MEDIA_MAX_OUTPUT_BYTES', 20 * GiB),
  workspaceBytes: bound('TEMPORAL_MEDIA_WORKSPACE_MAX_BYTES', 64 * GiB),
  headroomBytes: bound('TEMPORAL_MEDIA_DISK_HEADROOM_BYTES', 16 * GiB),
};
if (
  mediaResources.sourceBytes > 20 * GiB ||
  mediaResources.workspaceBytes < mediaResources.sourceBytes + 2 * mediaResources.outputBytes ||
  mediaResources.headroomBytes < GiB
)
  throw new Error('Media resource budgets are inconsistent.');
let reservedBytes = 0;
export async function reserveMediaWorkspace(directory: string): Promise<() => void> {
  const disk = await statfs(directory);
  const available = Number(disk.bavail) * Number(disk.bsize);
  // No await between checking and reserving: concurrent activities serialize their reservation.
  if (available < reservedBytes + mediaResources.workspaceBytes + mediaResources.headroomBytes)
    throw ApplicationFailure.retryable('Audio workspace capacity is temporarily unavailable', 'MEDIA_DISK_CAPACITY');
  reservedBytes += mediaResources.workspaceBytes;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      reservedBytes -= mediaResources.workspaceBytes;
    }
  };
}
export async function checkMediaWorkspace(directory: string): Promise<void> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = await stat(join(directory, entry.name));
    total += file.size;
    const limit = /^(processed|final)\./.test(entry.name) ? mediaResources.outputBytes : mediaResources.sourceBytes;
    if (file.size > limit)
      throw ApplicationFailure.nonRetryable('Audio exceeds the supported byte budget', 'MEDIA_BYTE_BUDGET');
  }
  if (total > mediaResources.workspaceBytes)
    throw ApplicationFailure.nonRetryable('Audio exceeds the workspace byte budget', 'MEDIA_WORKSPACE_BUDGET');
}
