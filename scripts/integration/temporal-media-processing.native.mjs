import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(new URL('../../package.json', import.meta.url));
require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const { runNativeMediaProcessingCanary } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/media-processing-canary.ts', import.meta.url)
));
// Linux CI uses the worker's default paths and validates the installed files' ownership.
const localBinaries =
  process.platform === 'darwin' ? { ffmpeg: '/opt/homebrew/bin/ffmpeg', ffprobe: '/opt/homebrew/bin/ffprobe' } : {};
for (const mode of ['native-tools', 'pre-aborted', 'wrong-tool'])
  test(`actual synthetic PCM processing/cancel-drain/retry / ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'urm-media-processing-'));
    try {
      const controller = new AbortController();
      if (mode === 'pre-aborted') controller.abort();
      const options = {
        directory,
        signal: controller.signal,
        ...localBinaries,
        ...(mode === 'wrong-tool' ? { ffmpeg: process.execPath } : {}),
      };
      if (mode !== 'native-tools')
        await assert.rejects(runNativeMediaProcessingCanary(options), /MEDIA_NATIVE_PROCESSING_CANARY_UNCONFIRMED/);
      else {
        const result = await runNativeMediaProcessingCanary(options);
        assert.equal(result.pcmSamplesVerified, 16000);
        assert.equal(result.sourceBytes, 32044);
        assert.equal(result.durationSeconds, 1);
        assert.equal(result.progressBeforeCancellation, true);
        assert.equal(result.cancelledChildDrained, true);
        assert.equal(result.retryCompleted, true);
        assert.match(result.ffmpegSHA256, /^[a-f0-9]{64}$/);
        assert.match(result.ffprobeSHA256, /^[a-f0-9]{64}$/);
        assert.deepEqual((await readdir(directory)).sort(), ['processed.wav', 'source.wav']);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
