import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectNativeYouTubeProcess } from '../../../process-audio/src/temporal/hetzner-acquisition-identity';
import {
  activeRenderProfileSnapshot,
  readRenderProfileSeal,
} from '../../../process-audio/src/temporal/hetzner-render-profile';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  closeRenderAuthentication,
  prepareRenderAuthentication,
  readPreparedRenderAuthentication,
  recordRenderAuthenticationProbe,
} from '../../../process-audio/src/temporal/hetzner-render-authentication';
import { readRenderAuthenticationPredecessor } from '../../../process-audio/src/temporal/hetzner-acquisition-episode';
import { retainedYouTubeRenderSlot, youtubeRenderSlot } from '../../../process-audio/src/temporal/hetzner-render-slot';

jest.mock('../../../process-audio/src/temporal/hetzner-acquisition-identity', () => ({
  inspectNativeYouTubeProcess: jest.fn(),
}));
jest.mock('../../../process-audio/src/temporal/hetzner-acquisition-episode', () => ({
  readRenderAuthenticationPredecessor: jest.fn(),
}));
jest.mock('../../../process-audio/src/temporal/hetzner-acquisition-store', () => ({
  assertStagingAcquisitionDatabase: jest.fn(),
  validateAcquisitionPreparer: (caller: unknown) => caller,
}));
const ref = {
  projectId: 'urm-app-staging',
  jobId: 'job',
  sermonId: 'sermon',
  revision: 1,
  requestVersion: '0123456789abcdef',
};
const id = '01234567-0123-4123-8123-0123456789ab';
const episodeId = '01234567-0123-4123-8123-0123456789ac';
const verifiedCallerEmail = 'fixture';
const stamp = { isEqual: (other: unknown) => other === stamp, seconds: 1, nanoseconds: 2 };
const owner = {
  processId: 42,
  bootId: 'fixture-boot',
  pidNamespace: 'pid:[1]',
  buildId: 'a'.repeat(40),
  startTicks: '123',
};
const close = { processId: 42, outcome: 'failed', exitCode: 2, exitSignal: null, closedAt: 30 } as const;
const claim = { id, episodeId, intentVersion: stamp, owner, startedAt: 20 };
const invocation = { workflowId: 'workflow', runId: 'run', activityId: 'acquire', attempt: 1 };
interface FixtureCollection {
  doc(key: string): FixtureDocument;
}
interface FixtureDocument {
  path: string;
  parent: FixtureCollection;
  collection(name: string): FixtureCollection;
}
const doc = (path: string): FixtureDocument => ({
  path,
  parent: { doc: (key) => doc([...path.split('/').slice(0, -1), key].join('/')) },
  collection: (name) => ({ doc: (key) => doc([path, name, key].filter(Boolean).join('/')) }),
});
function fixture() {
  const execution = doc('execution');
  const pointer = execution.collection('render').doc('authentication');
  const attempt = pointer.collection('attempts').doc(id);
  const facts = attempt.collection('facts');
  const slot = doc('').collection('temporalYouTubeRenderHosts').doc('staging');
  const rows = new Map<string, Record<string, unknown>>([
    [pointer.path, { id, ordinal: 1 }],
    [
      attempt.path,
      {
        schemaVersion: 1,
        id,
        ordinal: 1,
        ref,
        episodeId,
        candidateHash: 'candidate',
        closeHash: 'close',
        caller: { serviceAccount: verifiedCallerEmail, buildId: owner.buildId },
        invocation: { ...invocation, activityId: 'recover' },
      },
    ],
    [facts.doc('authorized').path, { intentVersion: stamp }],
    [facts.doc('claim').path, claim],
    [facts.doc('dispatch').path, { intentVersion: stamp }],
    [slot.path, youtubeRenderSlot(ref, episodeId, id)],
  ]);
  const tx = {
    get: async (reference: ReturnType<typeof doc>) => {
      const data = rows.get(reference.path);
      return {
        exists: data !== undefined,
        ref: reference,
        data: () => data,
        get: (field: string) =>
          field
            .split('.')
            .reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], data),
        createTime: stamp,
        updateTime: stamp,
      };
    },
    create: jest.fn((reference: ReturnType<typeof doc>, data: Record<string, unknown>) =>
      rows.set(reference.path, data)
    ),
    set: jest.fn((reference: ReturnType<typeof doc>, data: Record<string, unknown>) => rows.set(reference.path, data)),
    delete: jest.fn((reference: ReturnType<typeof doc>) => rows.delete(reference.path)),
  };
  const firestore = {
    collection: doc('').collection,
    runTransaction: jest.fn(async (run: (value: typeof tx) => Promise<void>) => run(tx)),
  };
  jest.mocked(readRenderAuthenticationPredecessor).mockResolvedValue({
    execution: { ref: execution },
    episode: { id: episodeId, invocation, preparedBy: { buildId: owner.buildId } },
    candidateHash: 'candidate',
    closeHash: 'close',
  } as unknown as Awaited<ReturnType<typeof readRenderAuthenticationPredecessor>>);
  return { tx, firestore: firestore as unknown as Firestore, facts, pointer, slot, rows };
}
test('original failed probe commits completion, drain and slot release together without granting a generation', async () => {
  const { tx, firestore, facts, slot } = fixture();
  await closeRenderAuthentication({
    firestore,
    ref,
    verifiedCallerEmail,
    id,
    close,
    claim: claim as unknown as Parameters<typeof closeRenderAuthentication>[0]['claim'],
    ipcAttempted: false,
  });
  expect(firestore.runTransaction).toHaveBeenCalledTimes(1);
  expect(tx.delete).toHaveBeenCalledWith(expect.objectContaining({ path: slot.path }));
  expect(tx.create).toHaveBeenCalledWith(expect.objectContaining({ path: facts.doc('drain').path }), {
    id,
    owner,
    close,
  });
  expect(tx.create).toHaveBeenCalledWith(expect.objectContaining({ path: facts.doc('completion').path }), {
    id,
    owner,
    close,
    intentVersion: stamp,
    probeVersion: null,
    profileSeal: null,
    status: 'failed',
  });
});

test('original failed close fences a late unclaimed auth transaction with the same slot', async () => {
  const { tx, firestore, facts, rows, slot } = fixture();
  rows.delete(facts.doc('claim').path);
  const input = { firestore, ref, verifiedCallerEmail, id };
  await closeRenderAuthentication({
    ...input,
    close,
    claim: claim as unknown as Parameters<typeof closeRenderAuthentication>[0]['claim'],
    ipcAttempted: false,
  });
  expect(rows.has(slot.path)).toBe(false);
  expect(rows.has(facts.doc('claim').path)).toBe(false);
  expect(rows.get(facts.doc('completion').path)).toMatchObject({
    neverClaimed: true,
    status: 'failed',
    probeVersion: null,
  });
  const read = () => firestore.runTransaction((transaction) => readPreparedRenderAuthentication(transaction, input));
  await expect(read()).resolves.toMatchObject({ id });
  expect(tx.create).toHaveBeenCalledTimes(2);
  rows.set(facts.doc('claim').path, claim);
  await expect(read()).rejects.toThrow('YOUTUBE_RENDER_AUTHENTICATION_UNCONFIRMED');
});

test('a later Activity attempt replaces an unarmed intent without authorizing or dispatching the original', async () => {
  const { firestore, facts, pointer, slot, rows } = fixture();
  for (const name of ['authorized', 'claim', 'dispatch']) rows.delete(facts.doc(name).path);
  rows.delete(slot.path);
  const input = {
    firestore,
    ref,
    caller: { serviceAccount: verifiedCallerEmail, buildId: owner.buildId, instanceId: 'fixture' },
    invocation: { ...invocation, activityId: 'recover' },
    assertCurrent: async () => {},
    signal: new AbortController().signal,
  };
  await expect(prepareRenderAuthentication(input)).rejects.toThrow('YOUTUBE_RENDER_AUTHENTICATION_UNCONFIRMED');
  expect(rows.get(pointer.path)).toEqual({ id, ordinal: 1 });
  const next = await prepareRenderAuthentication({ ...input, invocation: { ...input.invocation, attempt: 2 } });
  expect(next).not.toBe(id);
  expect(rows.get(pointer.path)).toEqual({ id: next, ordinal: 2 });
  expect(rows.get(facts.doc('abandoned').path)).toEqual({ id, intentVersion: stamp, successorId: next });
  expect(rows.has(facts.doc('authorized').path)).toBe(false);
  expect(rows.has(facts.doc('dispatch').path)).toBe(false);
  expect(rows.has(slot.path)).toBe(false);
  const read = (attemptId: string) =>
    firestore.runTransaction((tx) =>
      readPreparedRenderAuthentication(tx, { firestore, ref, verifiedCallerEmail, id: attemptId })
    );
  await expect(read(id)).rejects.toThrow('YOUTUBE_RENDER_AUTHENTICATION_UNCONFIRMED');
  await expect(read(next)).resolves.toMatchObject({ id: next });
});

test('dispatch or a host reservation keeps a missing authorization fenced', async () => {
  const { firestore, facts, pointer, slot, rows } = fixture();
  rows.delete(facts.doc('authorized').path);
  rows.delete(facts.doc('claim').path);
  const input = {
    firestore,
    ref,
    caller: { serviceAccount: verifiedCallerEmail, buildId: owner.buildId, instanceId: 'fixture' },
    invocation: { ...invocation, activityId: 'recover', attempt: 2 },
    assertCurrent: async () => {},
    signal: new AbortController().signal,
  };
  await expect(prepareRenderAuthentication(input)).rejects.toThrow('YOUTUBE_RENDER_AUTHENTICATION_UNCONFIRMED');
  rows.delete(facts.doc('dispatch').path);
  await expect(prepareRenderAuthentication(input)).rejects.toThrow('YOUTUBE_RENDER_AUTHENTICATION_UNCONFIRMED');
  expect(rows.get(pointer.path)).toEqual({ id, ordinal: 1 });
  expect(rows.has(slot.path)).toBe(true);
});

test('a successful original probe retains the staging host reservation until handoff regardless of age', async () => {
  const { tx, firestore, facts, slot, rows } = fixture();
  const profileSeal = 'b'.repeat(64);
  rows.set(facts.doc('probe').path, { id, claimVersion: stamp, checkedAt: 25, bytes: 128, profileSeal });
  await closeRenderAuthentication({
    firestore,
    ref,
    verifiedCallerEmail,
    id,
    close: { ...close, outcome: 'completed', exitCode: 0 },
    claim: claim as unknown as Parameters<typeof closeRenderAuthentication>[0]['claim'],
    ipcAttempted: true,
  });
  expect(tx.delete).not.toHaveBeenCalled();
  expect(rows.get(slot.path)).toEqual(retainedYouTubeRenderSlot(ref, episodeId, id));
  expect(rows.get(facts.doc('completion').path)).toMatchObject({ status: 'ready', retainedSlot: true, profileSeal });
  expect(Date.now() - close.closedAt).toBeGreaterThan(300000);
  tx.create.mockClear();
  tx.set.mockClear();
  await expect(
    prepareRenderAuthentication({
      firestore,
      ref,
      caller: { serviceAccount: verifiedCallerEmail, buildId: owner.buildId, instanceId: 'fixture' },
      invocation: { ...invocation, activityId: 'recover-later' },
      assertCurrent: async () => {},
      signal: new AbortController().signal,
    })
  ).resolves.toBe(id);
  expect(tx.create).not.toHaveBeenCalled();
  expect(tx.set).not.toHaveBeenCalled();
  expect(tx.delete).not.toHaveBeenCalled();
  expect(rows.get(slot.path)).toEqual(retainedYouTubeRenderSlot(ref, episodeId, id));
});

test.each([10, 4])('original authentication close only retries a definitive abort (%s)', async (code) => {
  const { firestore, facts, rows } = fixture();
  const transaction = jest.mocked(firestore.runTransaction);
  transaction.mockRejectedValueOnce(Object.assign(new Error('controlled close status'), { code }));
  const result = closeRenderAuthentication({
    firestore,
    ref,
    verifiedCallerEmail,
    id,
    close,
    claim: claim as unknown as Parameters<typeof closeRenderAuthentication>[0]['claim'],
    ipcAttempted: false,
  });
  if (code === 10) {
    await result;
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(rows.has(facts.doc('completion').path)).toBe(true);
  } else {
    await expect(result).rejects.toThrow('controlled close status');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(rows.has(facts.doc('completion').path)).toBe(false);
  }
});

test.each(['exact', 'missing drain', 'changed completion'])(
  'unknown close ACK reconciles only the original atomic receipt pair (%s)',
  async (scenario) => {
    const { tx, firestore, facts, rows, slot } = fixture();
    rows.set(facts.doc('probe').path, {
      id,
      claimVersion: stamp,
      checkedAt: 25,
      bytes: 128,
      profileSeal: 'b'.repeat(64),
    });
    const transaction = jest.mocked(firestore.runTransaction);
    const successor = youtubeRenderSlot(ref, '01234567-0123-4123-8123-0123456789ad');
    transaction.mockImplementationOnce(async (run) => {
      await run(tx as unknown as Transaction);
      if (scenario === 'missing drain') rows.delete(facts.doc('drain').path);
      if (scenario === 'changed completion') rows.set(facts.doc('completion').path, { id, status: 'failed' });
      rows.set(slot.path, successor);
      throw Object.assign(new Error('controlled lost close acknowledgement'), { code: 4 });
    });
    const result = closeRenderAuthentication({
      firestore,
      ref,
      verifiedCallerEmail,
      id,
      close: { ...close, outcome: 'completed', exitCode: 0 },
      claim: claim as unknown as Parameters<typeof closeRenderAuthentication>[0]['claim'],
      ipcAttempted: true,
    });
    if (scenario === 'exact') await result;
    else await expect(result).rejects.toThrow('controlled lost close acknowledgement');
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), { readOnly: true });
    expect(tx.create).toHaveBeenCalledTimes(2);
    expect(tx.set).toHaveBeenCalledTimes(1);
    expect(rows.get(slot.path)).toEqual(successor);
  }
);

test('the original authentication close retains custody while watcher completion is uncertain', async () => {
  const { tx, firestore, facts, slot, rows } = fixture();
  const attempted = { id, claimVersion: stamp, watcherRequestId: episodeId };
  rows.set(facts.doc('refreshAttempted').path, attempted);
  const finish = () =>
    closeRenderAuthentication({
      firestore,
      ref,
      verifiedCallerEmail,
      id,
      close,
      claim: claim as unknown as Parameters<typeof closeRenderAuthentication>[0]['claim'],
      ipcAttempted: true,
    });
  await expect(finish()).rejects.toThrow('YOUTUBE_RENDER_AUTHENTICATION_UNCONFIRMED');
  rows.set(facts.doc('refreshSettled').path, { ...attempted, id: episodeId, refreshed: false });
  await expect(finish()).rejects.toThrow('YOUTUBE_RENDER_AUTHENTICATION_UNCONFIRMED');
  expect(tx.delete).not.toHaveBeenCalled();
  expect(rows.has(slot.path)).toBe(true);
  expect(rows.has(facts.doc('completion').path)).toBe(false);
  rows.set(facts.doc('refreshSettled').path, { ...attempted, refreshed: false });
  await finish();
  expect(rows.has(slot.path)).toBe(false);
  expect(rows.get(facts.doc('completion').path)).toMatchObject({ status: 'failed' });
});

test('only the original terminal watcher receipt can settle a closed helper with no child acknowledgement', async () => {
  const { tx, firestore, facts, slot, rows } = fixture();
  const root = await mkdtemp(join(tmpdir(), 'render-refresh-parent-'));
  const previous = process.env.PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR;
  process.env.PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR = root;
  const attempted = { id, claimVersion: stamp, watcherRequestId: episodeId };
  rows.set(facts.doc('refreshAttempted').path, attempted);
  const finish = () =>
    closeRenderAuthentication({
      firestore,
      ref,
      verifiedCallerEmail,
      id,
      close,
      claim: claim as unknown as Parameters<typeof closeRenderAuthentication>[0]['claim'],
      ipcAttempted: true,
    });
  const result = join(root, `refresh-${episodeId}.result.json`);
  const otherResult = join(root, `refresh-${id}.result.json`);
  try {
    await writeFile(otherResult, '{"ok":true}');
    await symlink(otherResult, result);
    await expect(finish()).rejects.toThrow('YOUTUBE_RENDER_AUTHENTICATION_UNCONFIRMED');
    expect(tx.delete).not.toHaveBeenCalled();

    await rm(result);
    const request = join(root, `refresh-${episodeId}.claimed.json`);
    await writeFile(request, '{}');
    await Promise.all([
      finish(),
      new Promise((resolve) => setTimeout(resolve, 25)).then(async () => {
        await writeFile(result, '{"ok":false}');
        await rm(request);
      }),
    ]);
    expect(rows.get(facts.doc('refreshSettled').path)).toEqual({ ...attempted, refreshed: false });
    expect(rows.get(facts.doc('completion').path)).toMatchObject({ status: 'failed' });
    expect(rows.has(slot.path)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR;
    else process.env.PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('known refresh rechecks the original claim and canaries exactly the new main database', async () => {
  const { tx, facts, firestore, rows } = fixture();
  jest.mocked(inspectNativeYouTubeProcess).mockResolvedValue(owner);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'render-refresh-')));
  const setting = process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
  process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = root;
  const original = join(root, 'Default', 'Cookies');
  const signal = new AbortController().signal;
  const refresh = jest.fn(async () => {
    expect(activeRenderProfileSnapshot()).toBeUndefined();
    await writeFile(original, 'fresh fixture');
    return true;
  });
  let attempts = 0;
  try {
    await mkdir(join(root, 'Default'));
    await writeFile(original, 'stale fixture');
    const initialSeal = await readRenderProfileSeal(signal);
    await recordRenderAuthenticationProbe({
      firestore,
      ref,
      id,
      verifiedCallerEmail,
      buildId: owner.buildId,
      signal,
      directory: root,
      refresh,
      assertCurrent: async () => undefined,
      probe: async () => {
        const { directory } = activeRenderProfileSnapshot()!;
        const bytes = await readFile(join(directory, 'Cookies'), 'utf8');
        attempts++;
        expect(bytes).toBe(attempts === 1 ? 'stale fixture' : 'fresh fixture');
        return {
          scope: 'authenticated',
          checkedAt: new Date().toISOString(),
          succeeded: attempts === 2,
          bytesDownloaded: attempts === 2 ? 128 : 0,
          failureClass: attempts === 2 ? null : 'cookie_session_stale_or_challenged',
        };
      },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
    expect(firestore.runTransaction).toHaveBeenCalledTimes(5);
    expect(tx.create).toHaveBeenCalledTimes(3);
    const watcherRequestId = rows.get(facts.doc('refreshAttempted').path)?.watcherRequestId;
    expect(refresh).toHaveBeenCalledWith(watcherRequestId);
    expect(rows.get(facts.doc('refreshSettled').path)).toEqual({
      id,
      claimVersion: stamp,
      watcherRequestId,
      refreshed: true,
    });
    const seal = await readRenderProfileSeal(signal);
    expect(seal).not.toBe(initialSeal);
    expect(rows.get(facts.doc('probe').path)).toMatchObject({ profileSeal: seal, bytes: 128 });
  } finally {
    if (setting === undefined) delete process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
    else process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = setting;
    await rm(root, { recursive: true, force: true });
  }
});

test.each(['terminal failure', 'cancelled without terminal result'])(
  'the owned refresh mailbox only accepts a boolean watcher outcome (%s)',
  async (scenario) => {
    const { refreshRenderAuthenticationBrowser, withYouTubeCancellation } = await import(
      '../../../process-audio/src/processYouTubeUrl'
    );
    const { CancelToken } = await import('../../../process-audio/src/CancelToken');
    const { createContext } = await import('../../../process-audio/src/context');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'render-refresh-mailbox-')));
    const settings = ['PROCESS_AUDIO_BROWSER_PROFILE_DIR', 'PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR'];
    const previous = settings.map((key) => process.env[key]);
    for (const key of settings) process.env[key] = root;
    const token = new CancelToken();
    const request = join(root, `refresh-${id}.request.json`);
    const result = join(root, `refresh-${id}.result.json`);
    const pending = withYouTubeCancellation(token, () =>
      refreshRenderAuthenticationBrowser(createContext(ref.sermonId, 'fixture'), id)
    );
    void pending.catch(() => undefined);
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await readFile(request, 'utf8').catch(() => '')) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await readFile(request, 'utf8')).toContain('classified_yt_dlp_auth_failure');
      if (scenario === 'terminal failure') {
        await writeFile(result, JSON.stringify({ ok: false }), { flag: 'wx' });
        await expect(pending).resolves.toBe(false);
        await rm(request);
        expect(JSON.parse(await readFile(result, 'utf8'))).toEqual({ ok: false });
      } else {
        await writeFile(result, '{}', { flag: 'wx' });
        token.cancel();
        await expect(pending).rejects.toBeDefined();
        expect(await readFile(result, 'utf8')).toBe('{}');
        expect(await readFile(request, 'utf8')).toContain('classified_yt_dlp_auth_failure');
      }
    } finally {
      token.cancel();
      await pending.catch(() => undefined);
      for (const [index, key] of settings.entries()) {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      }
      await rm(root, { recursive: true, force: true });
    }
  }
);
