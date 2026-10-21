import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { runYouTubeAcquisitionProcess } from '../../../process-audio/src/temporal/hetzner-acquisition-process';
import type { MediaJobRef } from '../../../process-audio/src/temporal/types';

const run = (options: Omit<Parameters<typeof runYouTubeAcquisitionProcess>[0], 'authorize'>) =>
  runYouTubeAcquisitionProcess({ ...options, authorize: async () => true });

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
  await expect(run({ helperPath, directory, ref, signal: new AbortController().signal })).resolves.toBe('completed');
});
test('first episode sends the exact native-prepared ID and scratch root only after known enrollment and claim', async () => {
  const episodeId = '00000000-0000-4000-8000-000000000001';
  const helperPath = await helper(`process.once('message', m => {
    if (Object.keys(m).sort().join(',') !== 'directory,episodeId,operationId,ref' || m.episodeId !== '${episodeId}' || process.env.TMPDIR !== m.directory || !require('node:fs').existsSync(m.directory+'/known-enrolled-and-claimed')) process.exit(2);
    process.exit(0);
  });`);
  const events: string[] = [];
  await expect(
    runYouTubeAcquisitionProcess({
      helperPath,
      directory,
      episodeId,
      ref,
      signal: new AbortController().signal,
      authorize: async (pid) => {
        process.kill(pid, 0);
        await writeFile(join(directory, 'known-enrolled-and-claimed'), 'CONTROLLED_KNOWN_ROOT_AND_NATIVE_CLAIM');
        events.push('enrolled-and-claimed');
        return true;
      },
      onNativeClose: async (fact) => {
        expect(() => process.kill(-fact.processId, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
        events.push('original-close');
      },
    })
  ).resolves.toBe('completed');
  expect(events).toEqual(['enrolled-and-claimed', 'original-close']);
});
test('first episode cannot send IPC after a final authorization starves the original absolute observation deadline', async () => {
  const helperPath = await helper(
    `process.once('message', m => { require('node:fs').writeFileSync(m.directory+'/late-episode-IPC','bad'); process.exit(0); });`
  );
  const start = performance.now();
  const authorize = async () => {
    const until = performance.now() + 70;
    while (performance.now() < until) {
      /* actual event-loop starvation */
    }
    return true;
  };
  await expect(
    runYouTubeAcquisitionProcess({
      helperPath,
      directory,
      ref,
      signal: new AbortController().signal,
      episodeId: '00000000-0000-4000-8000-000000000001',
      authorize,
      assertStartFresh: () => {
        if (performance.now() - start >= 50) throw Error('CONTROLLED_ORIGINAL_TEST_DEADLINE');
      },
    })
  ).resolves.toBe('failed');
  await expect(access(join(directory, 'late-episode-IPC'))).rejects.toMatchObject({ code: 'ENOENT' });
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
  const running = run({ helperPath, directory, ref, signal: controller.signal });
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
  await expect(run({ helperPath, directory, ref, signal: new AbortController().signal })).resolves.toBe('failed');
});
test('pre-cancelled execution cannot start the helper', async () => {
  const helperPath = await helper(
    `require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'never-started'))},'bad');`
  );
  const controller = new AbortController();
  controller.abort(new Error('pre-cancelled'));
  await expect(run({ helperPath, directory, ref, signal: controller.signal })).rejects.toThrow('pre-cancelled');
  await expect(access(join(directory, 'never-started'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a direct helper exit cannot hide a still-live descendant', async () => {
  const helperPath = await helper(`process.once('message', () => {
    const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    child.once('spawn',()=>process.exit(0));
  });`);
  await expect(run({ helperPath, directory, ref, signal: new AbortController().signal })).resolves.toBe('failed');
});
test('a helper ignoring termination is killed and drained, rather than releasing capacity early', async () => {
  const helperPath = await helper(`process.once('message', m=>{
    process.on('SIGTERM',()=>{});
    require('node:fs').writeFileSync(m.directory+'/ready','ready');
    setInterval(()=>{},1000);
  });`);
  const controller = new AbortController();
  const running = run({ helperPath, directory, ref, signal: controller.signal });
  const settled = expect(running).resolves.toBe('cancelled');
  try {
    await waitFile('ready');
  } finally {
    controller.abort();
  }
  await settled;
}, 15000);

test('denied durable authorization cannot send the helper its execution message', async () => {
  const helperPath = await helper(
    `process.once('message',m=>{require('node:fs').writeFileSync(m.directory+'/unauthorized','bad');process.exit(0);});`
  );
  const authorize = jest.fn(async (pid: number) => {
    process.kill(pid, 0);
    return false;
  });
  await expect(
    runYouTubeAcquisitionProcess({ helperPath, directory, ref, signal: new AbortController().signal, authorize })
  ).resolves.toBe('failed');
  expect(authorize).toHaveBeenCalledTimes(1);
  await expect(access(join(directory, 'unauthorized'))).rejects.toMatchObject({ code: 'ENOENT' });
});
test('cancellation during durable authorization cannot later send execution IPC', async () => {
  const helperPath = await helper(
    `process.once('message',m=>{require('node:fs').writeFileSync(m.directory+'/late-start','bad');process.exit(0);});`
  );
  const controller = new AbortController();
  const authorize = async (_pid: number, signal: AbortSignal) => {
    controller.abort();
    await pause(20);
    return !signal.aborted;
  };
  await expect(
    runYouTubeAcquisitionProcess({ helperPath, directory, ref, signal: controller.signal, authorize })
  ).resolves.toBe('cancelled');
  await expect(access(join(directory, 'late-start'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('original live handle publishes parent closure only after CLOSE and positive group absence', async () => {
  const helperPath = await helper(`process.once('message',()=>process.exit(0));`);
  let originalPid: number | undefined;
  const onNativeClose = jest.fn(async (fact) => {
    expect(fact.processId).toBe(originalPid);
    expect(fact).toMatchObject({ exitCode: 0, exitSignal: null, outcome: 'completed' });
    expect(Number.isSafeInteger(fact.closedAt)).toBe(true);
    expect(() => process.kill(-fact.processId, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(Object.isFrozen(fact)).toBe(true);
  });
  await expect(
    runYouTubeAcquisitionProcess({
      helperPath,
      directory,
      ref,
      signal: new AbortController().signal,
      authorize: async (pid) => {
        originalPid = pid;
        return true;
      },
      onNativeClose,
    })
  ).resolves.toBe('completed');
  expect(onNativeClose).toHaveBeenCalledTimes(1);
});
test('unknown parent CLOSE acknowledgement rejects settled process instead of allowing reservation release', async () => {
  const helperPath = await helper(`process.once('message',()=>process.exit(0));`);
  const onNativeClose = jest.fn(async () => {
    throw Error('CONTROLLED_CLOSE_ACK_UNKNOWN');
  });
  await expect(
    runYouTubeAcquisitionProcess({
      helperPath,
      directory,
      ref,
      signal: new AbortController().signal,
      authorize: async () => true,
      onNativeClose,
    })
  ).rejects.toThrow('CONTROLLED_CLOSE_ACK_UNKNOWN');
  expect(onNativeClose).toHaveBeenCalledTimes(1);
});

test('abort while parent closure ACK is pending cannot signal the already-closed numeric process group', async () => {
  const helperPath = await helper(`process.once('message',()=>process.exit(0));`);
  const controller = new AbortController();
  await expect(
    runYouTubeAcquisitionProcess({
      helperPath,
      directory,
      ref,
      signal: controller.signal,
      authorize: async () => true,
      onNativeClose: async () => {
        const kill = jest.spyOn(process, 'kill');
        try {
          controller.abort();
          await pause(30);
          expect(kill).not.toHaveBeenCalled();
        } finally {
          kill.mockRestore();
        }
      },
    })
  ).resolves.toBe('completed');
});
