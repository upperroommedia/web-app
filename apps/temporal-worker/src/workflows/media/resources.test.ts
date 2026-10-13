import './resource-test-environment.cjs';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  checkMediaWorkspace,
  mediaResources,
  reserveMediaWorkspace,
} from '../../../../process-audio/src/temporal/resources';
import { downloadMediaStream } from '../../../../process-audio/src/temporal/native';
test('runtime rejects oversized streams and native output before accepting artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'media-resource-test-'));
  let release: (() => void) | undefined;
  try {
    release = await reserveMediaWorkspace(directory);
    await expect(
      downloadMediaStream(
        Readable.from([Buffer.alloc(8), Buffer.alloc(8)]),
        join(directory, 'source'),
        new AbortController().signal,
        10
      )
    ).rejects.toThrow('byte budget');
    const output = join(directory, 'processed.mp3');
    await writeFile(output, '');
    await truncate(output, mediaResources.outputBytes + 1);
    await expect(checkMediaWorkspace(directory)).rejects.toMatchObject({
      type: 'MEDIA_BYTE_BUDGET',
      nonRetryable: true,
    });
  } finally {
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});
