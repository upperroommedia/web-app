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
const { superviseMediaKernel, superviseMediaRecoveryKernel } = require(fileURLToPath(
  new URL('../../apps/temporal-worker/src/runtime/media-kernel-supervisor.ts', import.meta.url)
));
const witness = {
  buildId: 'a'.repeat(40),
  instanceId: randomUUID(),
  cloudRun: { projectId: 'urm-app-staging', region: 'us-central1', pool: 'controlled', revision: 'controlled' },
};
for (const kind of ['normal', 'diagnostic'])
  for (const mode of [
    'normal',
    'expired-birth-ack',
    'authority-drift',
    'lost-birth-ack',
    'ipc-error',
    'ipc-channel-error',
  ]) {
    test(`actual child launch/close / ${kind} / ${mode}`, { timeout: 15000 }, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'urm-kernel-'));
      const marker = join(dir, 'started'),
        entry = join(dir, 'child.cjs');
      let state,
        drift = false,
        deadline = Infinity,
        childPid;
      const snapshot = () => ({ exists: state !== undefined, data: () => state });
      const ref = { get: async () => snapshot() };
      const db = {
        doc: (name) => {
          assert.ok(
            name.startsWith(
              kind === 'normal' ? '_control/temporalMediaKernel-' : '_control/temporalMediaRecoveryKernel-'
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
            (kind === 'normal' ? superviseMediaKernel : superviseMediaRecoveryKernel)(db, cap, entry)
          );
          await assert.rejects(readFile(marker), { code: 'ENOENT' });
          assert.equal(state.stage, 'born');
        } else if (mode === 'ipc-channel-error') {
          await writeFile(
            entry,
            `process.on('SIGTERM',()=>process.exit(0));process.send({kind:'media-kernel-ready',nonce:${JSON.stringify(
              randomUUID()
            )},pid:process.pid},()=>process.disconnect());setInterval(()=>{},1000);`
          );
          await assert.rejects(
            (kind === 'normal' ? superviseMediaKernel : superviseMediaRecoveryKernel)(db, cap, entry)
          );
          assert.notEqual(state.stage, 'closed');
        } else if (mode === 'ipc-error') {
          // An invalid protocol causes an owned stop; error is never a closed fact.
          await writeFile(
            entry,
            "process.on('SIGTERM',()=>process.exit(0));process.send({kind:'invalid'});setInterval(()=>{},1000);"
          );
          await assert.rejects(
            (kind === 'normal' ? superviseMediaKernel : superviseMediaRecoveryKernel)(db, cap, entry)
          );
          assert.equal(state.stage, 'armed');
        } else {
          const result = await (kind === 'normal' ? superviseMediaKernel : superviseMediaRecoveryKernel)(
            db,
            cap,
            entry
          );
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
