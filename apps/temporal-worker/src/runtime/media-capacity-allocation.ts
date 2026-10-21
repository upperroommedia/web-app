import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { mkdtemp, open, realpath, stat, lstat, statfs, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runMediaCommand } from '../../../process-audio/src/temporal/native';

const GiB = 1024 ** 3;
export const MEDIA_ALLOCATION_BYTES = 64 * GiB;
const fail = (): never => {
  throw new Error('MEDIA_CAPACITY_ALLOCATION_UNCONFIRMED');
};
// Isolated Python ignores user site configuration and Python environment variables.
// No sparse-file or smaller-allocation fallback is allowed.
export const mediaAllocationProgram = `import os,sys,stat,json
p,n,dev,ino,uid=sys.argv[1:]
n,dev,ino,uid=map(int,(n,dev,ino,uid))
f=os.open(p,os.O_RDWR|os.O_NOFOLLOW)
try:
 s=os.fstat(f)
 assert stat.S_ISREG(s.st_mode) and s.st_dev==dev and s.st_ino==ino and s.st_uid==uid and s.st_nlink==1 and s.st_size==n and stat.S_IMODE(s.st_mode)==0o600
 os.posix_fallocate(f,0,n)
 os.fsync(f)
 s=os.fstat(f)
 assert s.st_dev==dev and s.st_ino==ino and s.st_size==n and s.st_blocks*512>=n
 print(json.dumps({'allocatedBytes':s.st_blocks*512},separators=(',',':')))
finally:
 os.close(f)
`;

export const MEDIA_ALLOCATION_PROGRAM_SHA256 = createHash('sha256').update(mediaAllocationProgram).digest('hex');

export interface MediaAllocationEvidence {
  schemaVersion: 1;
  requestedBytes: number;
  allocatedBytes: number;
  pythonSHA256: string;
  programSHA256: string;
  filesystemDevice: number;
  fileInode: number;
  availableBytesAfterAllocation: number;
  minimumAvailableBytesWhileHeld: number;
  startedAt: string;
  releasedAt: string;
  cleanupConfirmed: true;
}

/** Production uses fixed 64GiB, /tmp and the image's root-owned Python. Explicit
 * overrides exercise a small local file only; they cannot authorize a receipt. */
export async function allocateMediaCapacity(
  parentSignal: AbortSignal,
  test?: { directory: string; bytes: number; python: string }
) {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(8000)]);
  const parent = test?.directory ?? '/tmp',
    bytes = test?.bytes ?? MEDIA_ALLOCATION_BYTES;
  const deadline = Date.now() + 8000,
    startedAt = new Date().toISOString();
  const check = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) fail();
  };
  check();
  if (
    (await realpath(parent)) !== parent ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes > MEDIA_ALLOCATION_BYTES
  )
    fail();
  const python = await realpath(test?.python ?? '/usr/bin/python3'),
    binary = await stat(python);
  check();
  if (
    !binary.isFile() ||
    binary.size < 1 ||
    binary.size > 64 * 1024 ** 2 ||
    (!test && (binary.uid !== 0 || binary.mode & 0o022))
  )
    fail();
  const hash = createHash('sha256');
  let count = 0;
  for await (const chunk of createReadStream(python, { signal })) {
    count += chunk.length;
    if (count > 64 * 1024 ** 2) fail();
    hash.update(chunk);
    check();
  }
  const binaryAfter = await stat(python);
  if (
    count !== binary.size ||
    ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(
      (k) => binary[k as keyof typeof binary] !== binaryAfter[k as keyof typeof binaryAfter]
    )
  )
    fail();
  check();
  const directory = await mkdtemp(join(parent, 'temporal-media-allocation-'));
  const path = join(directory, 'capacity.bin');
  let file: Awaited<ReturnType<typeof open>> | undefined,
    minimum = Number.MAX_SAFE_INTEGER,
    allocated = 0;
  let released = false;
  const release = async () => {
    if (released) fail();
    // The command promise settles only at child close; no cleanup races a live allocator.
    try {
      await file?.close();
    } finally {
      await rm(directory, { recursive: true, force: false });
    }
    released = true;
  };
  try {
    file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.truncate(bytes);
    const identity = await file.stat();
    const held = async () => {
      check();
      const [s, p, disk, parentState] = await Promise.all([file!.stat(), lstat(path), statfs(directory), stat(parent)]);
      check();
      const available = Number(disk.bavail) * Number(disk.bsize);
      if (
        !s.isFile() ||
        !p.isFile() ||
        s.nlink !== 1 ||
        s.uid !== process.getuid?.() ||
        s.mode & 0o077 ||
        s.size !== bytes ||
        s.dev !== identity.dev ||
        s.ino !== identity.ino ||
        p.dev !== s.dev ||
        p.ino !== s.ino ||
        parentState.dev !== s.dev ||
        s.blocks * 512 < bytes ||
        !Number.isSafeInteger(available) ||
        available < (test ? 0 : 16 * GiB)
      )
        fail();
      allocated = s.blocks * 512;
      minimum = Math.min(minimum, available);
      return available;
    };
    check();
    const result = JSON.parse(
      await runMediaCommand(
        python,
        [
          '-I',
          '-S',
          '-c',
          mediaAllocationProgram,
          path,
          String(bytes),
          String(identity.dev),
          String(identity.ino),
          String(identity.uid),
        ],
        signal
      )
    );
    check();
    if (
      Object.keys(result).join(',') !== 'allocatedBytes' ||
      !Number.isSafeInteger(result.allocatedBytes) ||
      result.allocatedBytes < bytes
    )
      fail();
    const availableBytesAfterAllocation = await held();
    if (allocated !== result.allocatedBytes) fail();
    return {
      assertHeld: held,
      release: async (): Promise<MediaAllocationEvidence> => {
        await held();
        await release();
        check();
        return {
          schemaVersion: 1,
          requestedBytes: bytes,
          allocatedBytes: allocated,
          pythonSHA256: hash.digest('hex'),
          programSHA256: MEDIA_ALLOCATION_PROGRAM_SHA256,
          filesystemDevice: identity.dev,
          fileInode: identity.ino,
          availableBytesAfterAllocation,
          minimumAvailableBytesWhileHeld: minimum,
          startedAt,
          releasedAt: new Date().toISOString(),
          cleanupConfirmed: true,
        };
      },
      cleanup: release,
    };
  } catch {
    if (!released) await release();
    return fail();
  }
}
