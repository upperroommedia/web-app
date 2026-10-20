import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { runYouTubeAcquisitionProcess } from '../../../process-audio/src/temporal/hetzner-acquisition-process';
import type { MediaJobRef } from '../../../process-audio/src/temporal/types';

const ref: MediaJobRef = {
  projectId: 'urm-app-staging',
  jobId: 'process-test',
  sermonId: 'sermon-test',
  revision: 1,
  requestVersion: 'a'.repeat(16),
};
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'yt-acquisition-group-test-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function helper(source: string) {
  const helperPath = join(directory, 'helper.cjs');
  await writeFile(helperPath, source);
  return helperPath;
}
async function waitFile(name: string) {
  for (let n = 0; n < 100; n++) {
    try {
      await access(join(directory, name));
      return;
    } catch {
      await pause(25);
    }
  }
  throw new Error('Native fixture did not start');
}
test('a native helper receives only the bound private reference and local workspace', async () => {
  const helperPath = await helper(`process.once('message', m => {
    if (Object.keys(m).sort().join(',') !== 'directory,operationId,ref' || m.ref.jobId !== 'process-test' || !m.operationId.startsWith('ytacq-')) process.exit(2);
    process.exit(0);
  });`);
  await expect(
    runYouTubeAcquisitionProcess({ helperPath, directory, ref, signal: new AbortController().signal })
  ).resolves.toBe('completed');
});
test('cancelled native work drains its descendant process group before returning', async () => {
  const helperPath = await helper(`process.once('message', m => {
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e', 'setInterval(()=>{},1000)'],{stdio:'ignore'});
    child.once('spawn',()=>require('node:fs').writeFileSync(m.directory+'/ready','ready'));
    process.on('SIGTERM',()=>{ child.kill('SIGTERM'); child.once('close',()=>process.exit(0)); });
    setInterval(()=>{},1000);
  });`);
  const controller = new AbortController();
  const running = runYouTubeAcquisitionProcess({ helperPath, directory, ref, signal: controller.signal });
  const settled = expect(running).resolves.toBe('cancelled');
  try {
    await waitFile('ready');
  } finally {
    controller.abort();
  }
  await settled;
});
test('native helper diagnostics cannot escape into a durable error', async () => {
  const helperPath = await helper(
    `process.once('message',()=>{process.stderr.write('https://private.invalid/?token=SECRET');process.exit(3);});`
  );
  await expect(
    runYouTubeAcquisitionProcess({ helperPath, directory, ref, signal: new AbortController().signal })
  ).resolves.toBe('failed');
});
test('pre-cancelled execution cannot start the helper', async () => {
  const helperPath = await helper(
    `require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'never-started'))},'bad');`
  );
  const controller = new AbortController();
  controller.abort(new Error('pre-cancelled'));
  await expect(runYouTubeAcquisitionProcess({ helperPath, directory, ref, signal: controller.signal })).rejects.toThrow(
    'pre-cancelled'
  );
  await expect(access(join(directory, 'never-started'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a direct helper exit cannot hide a still-live descendant', async () => {
  const helperPath = await helper(`process.once('message', () => {
    const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    child.once('spawn',()=>process.exit(0));
  });`);
  await expect(
    runYouTubeAcquisitionProcess({ helperPath, directory, ref, signal: new AbortController().signal })
  ).resolves.toBe('failed');
});
test('a helper ignoring termination is killed and drained, rather than releasing capacity early', async () => {
  const helperPath = await helper(`process.once('message', m=>{
    process.on('SIGTERM',()=>{});
    require('node:fs').writeFileSync(m.directory+'/ready','ready');
    setInterval(()=>{},1000);
  });`);
  const controller = new AbortController();
  const running = runYouTubeAcquisitionProcess({ helperPath, directory, ref, signal: controller.signal });
  const settled = expect(running).resolves.toBe('cancelled');
  try {
    await waitFile('ready');
  } finally {
    controller.abort();
  }
  await settled;
}, 15000);
