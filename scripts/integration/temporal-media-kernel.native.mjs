/** Actual OS child/IPC/close with CONTROLLED journal and caller authority.
 * No application bootstrap, Firebase, Cloud Run, image or recovery acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(new URL('../../package.json', import.meta.url));
require('ts-node').register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const { superviseMediaKernel, superviseMediaRecoveryKernel, superviseRestoredMediaKernel } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/media-kernel-supervisor.ts', import.meta.url)
));
const witness = {
  buildId: 'a'.repeat(40),
  instanceId: randomUUID(),
  cloudRun: { projectId: 'urm-app-staging', region: 'us-central1', pool: 'controlled', revision: 'controlled' },
};
for (const kind of ['normal', 'diagnostic', 'restored'])
  for (const mode of [
    'normal',
    'expired-birth-ack',
    'authority-drift',
    'lost-birth-ack',
    'ipc-error',
    'ipc-channel-error',
    ...(kind === 'diagnostic' ? ['ignored-cleanup-signal'] : []),
  ]) {
    test(`actual child launch/close / ${kind} / ${mode}`, { timeout: 15000 }, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'urm-kernel-'));
      const marker = join(dir, 'started'),
        entry = join(dir, 'child.cjs');
      let state,
        drift = false,
        deadline = Infinity,
        childPid,
        bornAt;
      const snapshot = () => ({ exists: state !== undefined, data: () => state });
      const ref = { get: async () => snapshot() };
      const db = {
        doc: (name) => {
          assert.ok(
            name.startsWith(
              kind === 'normal'
                ? '_control/temporalMediaKernel-'
                : kind === 'restored'
                ? '_control/temporalRestoredMediaKernel-'
                : '_control/temporalMediaRecoveryKernel-'
            )
          );
          return ref;
        },
        runTransaction: async (fn, opts) => {
          let next;
          const result = await fn({
            get: async () => snapshot(),
            create: (_, v) => {
              next = v;
            },
            set: (_, v) => {
              next = v;
            },
          });
          if (next) {
            state = next;
            if (next.stage === 'born') {
              childPid = next.birth.pid;
              bornAt = performance.now();
              if (mode === 'expired-birth-ack') {
                deadline = Date.now() + 20;
                await new Promise((r) => setTimeout(r, 60));
              }
              if (mode === 'authority-drift') drift = true;
              if (mode === 'lost-birth-ack') throw new Error('CONTROLLED_UNKNOWN_ACK');
            }
          }
          return result;
        },
      };
      const cap = {
        context: {
          operationId: randomUUID(),
          intentSHA256: 'c'.repeat(64),
          parent: { ...witness, instanceId: randomUUID() },
        },
        authorize: async () => {
          if (drift) throw new Error('CONTROLLED_AUTHORITY_DRIFT');
        },
        checkFresh: () => {
          if (Date.now() >= deadline) throw new Error('CONTROLLED_EXPIRED');
        },
      };
      await writeFile(
        entry,
        `const fs=require('node:fs');
require(${JSON.stringify(
          require.resolve('ts-node')
        )}).register({skipProject:true,transpileOnly:true,compilerOptions:{module:'CommonJS',target:'ES2022',esModuleInterop:true,moduleResolution:'node'}});
const kernel=require(${JSON.stringify(
          fileURLToPath(new URL('../../apps/temporal-worker/src/runtime/media-kernel-supervisor.ts', import.meta.url))
        )});
process.on('SIGTERM',()=>process.exit(0));
(async()=>{
 await kernel.awaitMediaKernelLaunch();
 fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));
 await kernel.reportMediaKernelWitness(${JSON.stringify(witness)});
 setTimeout(()=>process.exit(0),20);
})().catch(()=>{process.exitCode=1;process.disconnect();});
`
      );
      try {
        if (['expired-birth-ack', 'authority-drift'].includes(mode)) {
          await assert.rejects(
            (kind === 'normal'
              ? superviseMediaKernel
              : kind === 'restored'
              ? superviseRestoredMediaKernel
              : superviseMediaRecoveryKernel)(db, cap, entry)
          );
          await assert.rejects(readFile(marker), { code: 'ENOENT' });
          assert.equal(state.stage, 'born');
        } else if (mode === 'ipc-channel-error') {
          await writeFile(
            entry,
            `const { randomUUID } = require('node:crypto');
process.on('SIGTERM', () => process.exit(0));
process.send({ kind: 'media-kernel-ready', nonce: randomUUID(), pid: process.pid }, () => process.disconnect());
setInterval(() => {}, 1000);
`
          );
          await assert.rejects(
            (kind === 'normal'
              ? superviseMediaKernel
              : kind === 'restored'
              ? superviseRestoredMediaKernel
              : superviseMediaRecoveryKernel)(db, cap, entry)
          );
          assert.notEqual(state.stage, 'closed');
        } else if (mode === 'ignored-cleanup-signal') {
          await writeFile(
            entry,
            `const { randomUUID } = require('node:crypto');
process.on('SIGTERM', () => {});
process.send({ kind: 'media-kernel-ready', nonce: randomUUID(), pid: process.pid });
setTimeout(() => process.exit(0), 12000);
`
          );
          // Initial authority must hold. Revoke only after the owned child is born.
          await assert.rejects(
            superviseMediaRecoveryKernel(
              db,
              {
                ...cap,
                authorize: async () => {
                  if (childPid !== undefined) throw new Error('CONTROLLED_AUTHORITY_DRIFT');
                },
              },
              entry
            )
          );
          assert.equal(state.stage, 'born');
          assert.ok(childPid > 0);
          assert.ok(performance.now() - bornAt < 11500, 'Original child outlasted the Cloud Run shutdown budget');
        } else if (mode === 'ipc-error') {
          // An invalid protocol causes an owned stop; error is never a closed fact.
          await writeFile(
            entry,
            "process.on('SIGTERM',()=>process.exit(0));process.send({kind:'invalid'});setInterval(()=>{},1000);"
          );
          await assert.rejects(
            (kind === 'normal'
              ? superviseMediaKernel
              : kind === 'restored'
              ? superviseRestoredMediaKernel
              : superviseMediaRecoveryKernel)(db, cap, entry)
          );
          assert.equal(state.stage, 'armed');
        } else {
          const result = await (kind === 'normal'
            ? superviseMediaKernel
            : kind === 'restored'
            ? superviseRestoredMediaKernel
            : superviseMediaRecoveryKernel)(db, cap, entry);
          assert.equal(result.code, 0);
          assert.equal(state.stage, 'closed');
          assert.equal(state.close.descendantsAbsent, true);
          assert.equal(await readFile(marker, 'utf8'), String(state.birth.pid));
        }
        if (childPid) assert.throws(() => process.kill(-childPid, 0), { code: 'ESRCH' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

// Actual original live-handle SIGKILL/close/group drain. Artifact/store/caller
// metadata below are CONTROLLED; this is not source Activity or image acceptance.
const { superviseOriginalMediaFault, originalMediaArtifacts } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/media-recovery-original-fault.ts', import.meta.url)
));
const { workerReadinessDigest: hash } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/readiness-probe.ts', import.meta.url)
));
const { createHash } = await import('node:crypto');
for (const mode of [
  'normal-fault',
  'signal-commit-ack-loss',
  'signal-not-committed',
  'grant-drift',
  'invalid-ready-time',
  'replacement-generation',
  'native-attempt-expired',
  'changed-current-pin',
  'missing-current-pin',
  'late-signal-authority-ack',
]) {
  test(`actual original-handle fault / ${mode}`, { timeout: 15000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'urm-original-fault-'));
    const entry = join(dir, 'child.cjs'),
      op = randomUUID(),
      runId = randomUUID();
    const docs = new Map();
    const name = (kind) => `_control/temporalMediaRecovery${kind}-${op}`;
    let childPid,
      forks = 0,
      signalWrites = 0;
    const ref = {
      jobId: `media-recovery-${op}`,
      projectId: 'urm-app-staging',
      sermonId: `media-recovery-${op}`,
      requestVersion: 'a'.repeat(16),
      revision: 1,
    };
    const bytes = Buffer.from('CONTROLLED synthetic artifact bytes');
    const prefix = `workflow-audio/media-recovery-${op}/`;
    const names = [`${prefix}source.wav`, `${prefix}processed.wav`];
    const metadata = names.map((n, i) => ({
      name: n,
      generation: String(i + 1),
      size: String(bytes.length),
      md5Hash: createHash('md5').update(bytes).digest('base64'),
    }));
    const bucket = {
      name: 'urm-app-staging.firebasestorage.app',
      getFiles: async () => [metadata.map((m) => ({ name: m.name, getMetadata: async () => [m] })), null],
      file: (n, options) => ({
        getMetadata: async () => [
          {
            ...metadata.find((m) => m.name === n),
            ...(mode === 'replacement-generation' && !options ? { generation: '999' } : {}),
          },
        ],
        download: async () => [bytes],
      }),
    };
    const request = {
      artifacts: { source: { path: names[0], generation: '1' }, processed: { path: names[1], generation: '2' } },
    };
    const updateTime = {
      seconds: 1,
      nanoseconds: 2,
      isEqual: (other) => other?.seconds === 1 && other?.nanoseconds === 2,
    };
    const snapshot = (key) => ({
      exists: docs.has(key),
      data: () => structuredClone(docs.get(key)),
      get: (field) => field.split('.').reduce((v, k) => v?.[k], docs.get(key)),
    });
    const db = {
      doc: (key) => ({
        key,
        get: async () =>
          key.startsWith('temporalMediaRequests/')
            ? {
                exists: true,
                data: () => request,
                get: (field) => field.split('.').reduce((v, k) => v?.[k], request),
                updateTime,
              }
            : snapshot(key),
      }),
      runTransaction: async (fn) => {
        const pending = [];
        const result = await fn({
          get: async (r) => snapshot(r.key),
          create: (r, v) => pending.push([r.key, v]),
          set: (r, v) => pending.push([r.key, v]),
        });
        for (const [key, value] of pending) {
          if (key === name('OriginalSignal')) {
            signalWrites++;
            if (mode === 'signal-not-committed') throw new Error('CONTROLLED_UNKNOWN_ACK');
          }
          docs.set(key, structuredClone(value));
          if (key === name('Kernel') && value.stage === 'born') {
            childPid = value.birth.pid;
            forks++;
          }
          if (key === name('Kernel') && value.stage === 'running') {
            const grant = { runId, ref };
            docs.set(name('Work'), { stage: 'admitted', worker: value.worker, grant });
            startedAt = Date.now();
            const ready = {
              schemaVersion: 1,
              kind: 'settled-original-acquire-before-completion-ack',
              operationId: op,
              intentSHA256: cap.context.intentSHA256,
              birthDigest: hash({
                context: value.context,
                intent: value.intent,
                birth: value.birth,
                worker: value.worker,
              }),
              grantSHA256: hash(grant),
              nativeAttempt: {
                scheduledEventId: '7',
                startedAt,
                workerIdentity: `media-recovery-${witness.instanceId}`,
                attempt: 1,
              },
              worker: value.worker,
              workflowId: ref.jobId,
              runId,
              activityId: 'media-recovery-acquire',
              attempt: 1,
              ref,
              inventory: await originalMediaArtifacts(
                db,
                {
                  ...bucket,
                  file: (n, opts) => ({
                    getMetadata: async () => [metadata.find((m) => m.name === n)],
                    download: async () => [bytes],
                  }),
                },
                op
              ),
              observedAt: mode === 'invalid-ready-time' ? 'invalid' : new Date().toISOString(),
            };
            docs.set(name('OriginalReady'), ready);
            if (mode === 'grant-drift') docs.get(name('Work')).grant.runId = randomUUID();
          }
          if (key === name('OriginalSignal') && mode === 'signal-commit-ack-loss')
            throw new Error('CONTROLLED_UNKNOWN_ACK');
        }
        return result;
      },
    };
    const cap = {
      context: { operationId: op, intentSHA256: 'c'.repeat(64), parent: { ...witness, instanceId: randomUUID() } },
      authorize: async () => {
        if (mode === 'late-signal-authority-ack' && docs.has(name('OriginalSignal')))
          await new Promise((r) => setTimeout(r, 4100));
      },
      checkFresh: () => {},
    };
    let startedAt;
    const client = {
      connection: { withDeadline: async (_, fn) => fn() },
      workflowService: {
        getWorkflowExecutionHistory: async () => ({
          history: {
            events: [
              {
                eventId: 7,
                activityTaskScheduledEventAttributes: {
                  activityId: 'media-recovery-acquire',
                  activityType: { name: 'acquireMedia' },
                  taskQueue: { name: 'urm-media-kernel-recovery' },
                },
              },
            ],
          },
        }),
      },
      workflow: {
        getHandle: () => ({
          describe: async () => ({
            raw: {
              workflowExecutionInfo: {
                execution: { runId },
                status: 1,
                versioningInfo: {
                  behavior: 1,
                  versioningOverride:
                    mode === 'missing-current-pin'
                      ? undefined
                      : {
                          pinned: {
                            behavior: 1,
                            version: {
                              deploymentName: 'urm-worker-media-recovery-staging',
                              buildId: mode === 'changed-current-pin' ? 'f'.repeat(40) : witness.buildId,
                            },
                          },
                        },
                  deploymentVersion: { deploymentName: 'urm-worker-media-recovery-staging', buildId: witness.buildId },
                },
              },
              pendingActivities: [
                {
                  activityId: 'media-recovery-acquire',
                  activityType: { name: 'acquireMedia' },
                  state: 2,
                  attempt: mode === 'native-attempt-expired' ? 2 : 1,
                  lastWorkerIdentity: `media-recovery-${witness.instanceId}`,
                  lastStartedTime: { seconds: Math.floor(startedAt / 1000), nanos: (startedAt % 1000) * 1e6 },
                  lastDeploymentVersion: {
                    deploymentName: 'urm-worker-media-recovery-staging',
                    buildId: witness.buildId,
                  },
                },
              ],
            },
          }),
        }),
      },
    };
    await writeFile(
      entry,
      `require(${JSON.stringify(
        require.resolve('ts-node')
      )}).register({skipProject:true,transpileOnly:true,compilerOptions:{module:'CommonJS',target:'ES2022',esModuleInterop:true,moduleResolution:'node'}});
const kernel=require(${JSON.stringify(
        fileURLToPath(new URL('../../apps/temporal-worker/src/runtime/media-kernel-supervisor.ts', import.meta.url))
      )});
process.on('SIGTERM',()=>process.exit(0));
(async()=>{await kernel.awaitMediaKernelLaunch();await kernel.reportMediaKernelWitness(${JSON.stringify(
        witness
      )});setInterval(()=>{},1000);})().catch(()=>process.exit(1));`
    );
    try {
      if (['normal-fault', 'signal-commit-ack-loss'].includes(mode)) {
        assert.deepEqual(await superviseOriginalMediaFault(db, bucket, cap, entry, client), {
          code: null,
          signal: 'SIGKILL',
        });
        assert.equal(
          docs.get(name('OriginalDeath')).kind,
          'original-application-child-death-only-no-replacement-authority'
        );
        assert.equal(docs.get(name('OriginalDeath')).originalRunId, runId);
        assert.equal(docs.get(name('Kernel')).close.descendantsAbsent, true);
        assert.equal(signalWrites, 1);
        await assert.rejects(superviseOriginalMediaFault(db, bucket, cap, entry, client));
      } else {
        await assert.rejects(superviseOriginalMediaFault(db, bucket, cap, entry, client));
        assert.equal(docs.has(name('OriginalDeath')), false);
        if (mode === 'grant-drift') {
          assert.equal(docs.get(name('Kernel')).stage, 'closed');
          assert.equal(docs.get(name('Kernel')).close.observerFailed, true);
        }
      }
      assert.equal(forks, 1);
      if (childPid) assert.throws(() => process.kill(-childPid, 0), { code: 'ESRCH' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
