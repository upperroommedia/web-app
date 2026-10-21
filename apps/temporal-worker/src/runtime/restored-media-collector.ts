/** Historical startup reader only. No fresh canary, child birth, expiry renewal,
 * queue permission, Activity execution or release readiness is granted here. */
import type { Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import {
  restoredMediaStartupIntent,
  restoredMediaHistoricalStartupIntent,
  RESTORED_MEDIA_STARTUP_COLLECTION,
} from './restored-media-startup';
import { validateMediaKernelBirthRecord } from './media-kernel-supervisor';
import { validateHistoricalMediaRecoveryCapacity } from './media-startup-capacity';
import { workerReadinessDigest as hash } from './readiness-probe';
import { releaseProvenanceDigest as proof } from './media-recovery-history';
const fail = (): never => {
  throw new Error('RESTORED_MEDIA_STARTUP_READBACK_UNCONFIRMED');
};
const exact = (x: any, keys: string) => {
  if (!x || Object.keys(x).sort().join(',') !== keys.split(',').sort().join(',')) fail();
};
const stamp = (s: any) => ({
  exists: s.exists,
  dataSHA256: s.exists ? proof(s.data()) : null,
  createTime: s.createTime ? { seconds: s.createTime.seconds, nanoseconds: s.createTime.nanoseconds } : null,
  updateTime: s.updateTime ? { seconds: s.updateTime.seconds, nanoseconds: s.updateTime.nanoseconds } : null,
});
const millis = (s: any) => s?.seconds * 1000 + Math.floor(s?.nanoseconds / 1e6);
const time = (x: any) => {
  const at = Date.parse(x);
  if (!Number.isFinite(at) || at > Date.now() + 5000) fail();
  return at;
};
type Options = {
  db: Firestore;
  auth: Auth;
  operationId: string;
  bindingDigest: string;
  plan: any;
  pool: any;
  expectedRootSHA256: string;
  expectedControlSHA256: string;
  expectedStateSHA256: string;
  image: { pythonSHA256: string; ffmpegSHA256: string; ffprobeSHA256: string };
};
export async function collectRestoredMediaStartup(o: Options) {
  return collectStartup(o, 'retained');
}
/** Fixed phase reader. Absence or incomplete startup never yields an identity;
 * historical cleanup does not reuse the live 120-second capability. */
export async function collectRestoredMediaPhaseStartup(o: Options) {
  return collectStartup(o, 'phase');
}
async function collectStartup(o: Options, scope: 'retained' | 'phase') {
  const began = Date.now(),
    mono = performance.now();
  let active = true;
  const fresh = () => {
    if (!active || Date.now() < began || Date.now() - began >= 5000 || performance.now() - mono >= 5000) fail();
  };
  const read = async <T>(fn: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      fresh();
      const value = await Promise.race([
        Promise.resolve().then(() => {
          fresh();
          return fn();
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('RESTORED_MEDIA_STARTUP_READBACK_UNCONFIRMED')),
            Math.max(1, 5000 - (Date.now() - began))
          );
        }),
      ]);
      fresh();
      return value;
    } catch {
      active = false;
      return fail();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    if (
      !('projectId' in o.db) ||
      o.db.projectId !== 'urm-app-staging' ||
      o.db.databaseId !== '(default)' ||
      o.auth.app.options.projectId !== 'urm-app-staging' ||
      o.plan?.operationId !== o.operationId ||
      o.plan.bindingDigest !== o.bindingDigest ||
      (scope === 'retained'
        ? o.pool?.desiredManualInstanceCount !== 1
        : ![0, 1].includes(o.pool?.desiredManualInstanceCount)) ||
      Object.values(o.image).some((v) => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))
    )
      fail();
    exact(o.image, 'pythonSHA256,ffmpegSHA256,ffprobeSHA256');
    const snapshots = () =>
      read(() =>
        o.db.runTransaction(
          async (tx) => {
            fresh();
            const all = await Promise.all(
              [
                '_control/temporalReleaseOperation',
                '_control/temporalRelease',
                '_control/temporalReleaseState',
                `_control/temporalMediaRecoveryCapsule-${o.plan.recoveryOperationId}`,
                `_control/temporalCloudMediaRecovery-${o.plan.recoveryOperationId}`,
                `_control/temporalRestoredMediaKernel-${o.operationId}`,
                `${RESTORED_MEDIA_STARTUP_COLLECTION}/${o.operationId}`,
              ].map((path) => tx.get(o.db.doc(path)))
            );
            if (
              (scope === 'retained' ? all.some((s) => !s.exists) : all.slice(0, 5).some((s) => !s.exists)) ||
              proof(all[0].data()) !== o.expectedRootSHA256 ||
              proof(all[1].data()) !== o.expectedControlSHA256 ||
              proof(all[2].data()) !== o.expectedStateSHA256
            )
              fail();
            return {
              root: all[0].data()!,
              control: all[1].data()!,
              state: all[2].data()!,
              capsule: all[3].data()!,
              completion: all[4].data()!,
              kernel: all[5].data()!,
              startup: all[6].data()!,
              stamps: all.map(stamp),
            };
          },
          { readOnly: true }
        )
      );
    const first = await snapshots(),
      { root, control, state, capsule, completion, kernel: k, startup: s } = first;
    const lifecycle = root.cloudRestoredMediaActivation;
    const owned = lifecycle?.start
      ? scope === 'retained'
        ? restoredMediaStartupIntent(root)
        : restoredMediaHistoricalStartupIntent(root)
      : null;
    const p = owned?.plan ?? o.plan;
    if (scope === 'retained' && !owned) fail();
    if (
      scope === 'phase' &&
      (!lifecycle ||
        hash(lifecycle.plan) !== hash(p) ||
        root.action !== 'activate-restored-cloud-run-media' ||
        root.operationId !== o.operationId ||
        root.bindingDigest !== o.bindingDigest ||
        root.releaseId !== p.releaseId)
    )
      fail();
    if (
      hash(p) !== hash(o.plan) ||
      (scope === 'retained' && (owned!.start.stage !== 'completed' || hash(owned!.start.pool) !== hash(o.pool))) ||
      (scope === 'phase' &&
        !owned &&
        (lifecycle.stage !== 'planned' || k || s || lifecycle.stop || lifecycle.cleanup)) ||
      root.operatorPrincipal?.adcAndGcloudAccountMatch !== true ||
      control.releaseId !== p.releaseId ||
      state.releaseId !== p.releaseId ||
      control.admission !== 'paused' ||
      state.phase !== 'provider-usage-ready' ||
      ['media', 'publishing', 'images', 'emails', 'accounts', 'bundles', 'search'].some(
        (d) => control.domains?.[d]?.admission !== 'paused'
      )
    )
      fail();
    const { capsuleSHA256, ...cap } = capsule;
    if (
      capsuleSHA256 !== p.origin.capsuleSHA256 ||
      proof(cap) !== capsuleSHA256 ||
      capsule.schemaVersion !== 1 ||
      capsule.kind !== 'completed-media-recovery-provenance-only-v1' ||
      capsule.operationId !== p.recoveryOperationId ||
      capsule.releaseId !== p.releaseId ||
      capsule.source?.buildId !== p.buildId ||
      capsule.source.image !== p.image ||
      capsule.source.evidenceDigest !== p.evidenceDigest ||
      capsule.completionSHA256 !== proof(completion) ||
      hash(capsule.restoredPool) !== hash(p.origin.pool)
    )
      fail();
    const stamps = first.stamps;
    for (const i of [3, 4, ...(s ? [6] : [])]) if (hash(stamps[i].createTime) !== hash(stamps[i].updateTime)) fail();
    if (hash(stamps[3].createTime) !== hash(stamps[4].createTime)) fail();
    const finishPhase = async (stage: string, identity: string | null = null) => {
      const actor = await read(() => o.auth.getUserByEmail(root.operatorPrincipal.email));
      if (
        actor.disabled ||
        actor.customClaims?.role !== 'admin' ||
        actor.email !== root.operatorPrincipal.email ||
        (k && actor.uid !== k.context.actorUid)
      )
        fail();
      if (proof(await snapshots()) !== proof(first)) fail();
      fresh();
      return {
        kind: 'restored-media-phase-startup-v1',
        operationId: p.operationId,
        planSHA256: hash(p),
        stage,
        allowedPollerIdentity: identity,
        originSHA256: k ? hash({ context: k.context, intent: k.intent }) : null,
        birthSHA256: k?.birth ? hash(k.birth) : null,
        workerSHA256: k?.worker ? hash(k.worker) : null,
        ownFactsSHA256: proof(first.stamps.slice(5)),
        proofSHA256: proof(first),
        observedAt: new Date(began).toISOString(),
        scope: 'identity-only-no-work-or-poll-authority',
      };
    };
    if (scope === 'phase' && !k) {
      if (s) fail();
      return finishPhase('absent');
    }
    const keys =
      scope === 'phase'
        ? k?.stage === 'armed'
          ? 'schemaVersion,stage,context,intent'
          : k?.stage === 'born'
          ? 'schemaVersion,stage,context,intent,birth'
          : k?.stage === 'closed'
          ? 'schemaVersion,stage,context,intent,birth,worker,close'
          : 'schemaVersion,stage,context,intent,birth,worker'
        : 'schemaVersion,stage,context,intent,birth,worker';
    exact(k, keys);
    exact(
      k.context,
      'operationId,intentSHA256,controlVersion,stateVersion,parent,protocol,recoveryOperationId,capsuleSHA256,actorUid'
    );
    if (
      k.schemaVersion !== 1 ||
      !(scope === 'retained' ? ['running'] : ['armed', 'born', 'running', 'closed']).includes(k.stage) ||
      k.context.protocol !== 'restored-normal-media-kernel-v1' ||
      k.context.operationId !== p.operationId ||
      k.context.recoveryOperationId !== p.recoveryOperationId ||
      k.context.capsuleSHA256 !== capsuleSHA256 ||
      k.context.intentSHA256 !== owned!.intentSHA256 ||
      k.context.controlVersion !== hash({ createTime: stamps[1].createTime, updateTime: stamps[1].updateTime }) ||
      k.context.stateVersion !== hash({ createTime: stamps[2].createTime, updateTime: stamps[2].updateTime })
    )
      fail();
    if (scope === 'phase') {
      exact(k.intent, 'createdAt,launchId,parentPid');
      const uuid = (x: any) =>
        typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
      const attempted = time(owned!.start.attemptedAt),
        intentAt = time(k.intent.createdAt);
      if (
        millis(stamps[5].createTime) < attempted - 5000 ||
        millis(stamps[5].createTime) > intentAt + 5000 ||
        millis(stamps[5].updateTime) < millis(stamps[5].createTime) ||
        (k.stage !== 'closed' && millis(stamps[5].updateTime) > attempted + 125000)
      )
        fail();
      const parent = k.context.parent,
        cloud = parent?.cloudRun;
      exact(parent, 'buildId,cloudRun,instanceId');
      if (
        !uuid(parent.instanceId) ||
        parent.buildId !== p.buildId ||
        !uuid(k.intent.launchId) ||
        !Number.isSafeInteger(k.intent.parentPid) ||
        k.intent.parentPid <= 0 ||
        intentAt < attempted ||
        intentAt > attempted + 120000 ||
        !cloud ||
        cloud.projectId !== 'urm-app-staging' ||
        cloud.region !== 'us-central1' ||
        cloud.pool !== o.pool.name.split('/').at(-1) ||
        cloud.revision !== o.pool.revision.split('/').at(-1) ||
        cloud.revisionUid !== o.pool.revisionUid ||
        cloud.imageDigest !== p.image.split('@')[1] ||
        cloud.serviceAccount !== `tw-m-${p.buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com` ||
        !cloud.instanceId
      )
        fail();
      if (k.birth) {
        exact(k.birth, 'nonce,pid,spawnedAt');
        if (
          !uuid(k.birth.nonce) ||
          !Number.isSafeInteger(k.birth.pid) ||
          k.birth.pid <= 0 ||
          k.birth.pid === k.intent.parentPid ||
          time(k.birth.spawnedAt) < intentAt ||
          time(k.birth.spawnedAt) > attempted + 120000
        )
          fail();
      }
      if (['armed', 'born'].includes(k.stage)) {
        if (s) fail();
        return finishPhase(k.stage);
      }
      if (k.stage === 'running' && !s) {
        const link = {
          operationId: p.operationId,
          birthDigest: hash({ context: k.context, intent: k.intent, birth: k.birth, worker: k.worker }),
        };
        validateMediaKernelBirthRecord(k, p.operationId, owned!.intentSHA256, link, k.worker);
        return finishPhase('running');
      }
      if (k.stage === 'closed') {
        exact(k.close, 'code,signal,observedAt,descendantsAbsent');
        if (
          !lifecycle.cleanup ||
          k.close.descendantsAbsent !== true ||
          !(k.close.code === null || Number.isInteger(k.close.code)) ||
          ![null, 'SIGTERM', 'SIGKILL'].includes(k.close.signal) ||
          time(k.close.observedAt) < time(s?.observedAt ?? k.birth.spawnedAt)
        )
          fail();
        if (!s) {
          const link = {
            operationId: p.operationId,
            birthDigest: hash({ context: k.context, intent: k.intent, birth: k.birth, worker: k.worker }),
          };
          validateMediaKernelBirthRecord(k, p.operationId, owned!.intentSHA256, link, k.worker);
          return finishPhase('closed'); // Closure only; no capacity or polling claim.
        }
      }
    }
    exact(
      s,
      'schemaVersion,kind,operationId,recoveryOperationId,intentSHA256,capsuleSHA256,kernel,worker,capacity,observedAt,digest'
    );
    const { digest, ...startup } = s;
    if (
      digest !== hash(startup) ||
      s.schemaVersion !== 1 ||
      s.kind !== 'restored-normal-media-startup-capacity-v1' ||
      s.operationId !== p.operationId ||
      s.recoveryOperationId !== p.recoveryOperationId ||
      s.intentSHA256 !== owned!.intentSHA256 ||
      s.capsuleSHA256 !== capsuleSHA256 ||
      hash(s.worker) !== hash(k.worker)
    )
      fail();
    const birth = validateMediaKernelBirthRecord(k, p.operationId, owned!.intentSHA256, s.kernel, s.worker);
    const attempted = time(owned!.start.attemptedAt),
      registered = time(s.observedAt),
      intentAt = time(k.intent.createdAt),
      born = time(k.birth.spawnedAt);
    if (
      intentAt < attempted ||
      born < intentAt ||
      registered < born ||
      registered > attempted + 120000 ||
      time(s.capacity?.observedAt) > registered ||
      millis(stamps[5].createTime) > millis(stamps[5].updateTime) ||
      (k.stage !== 'closed' && millis(stamps[5].updateTime) > millis(stamps[6].createTime) + 5000) ||
      registered > millis(stamps[6].createTime) + 5000 ||
      millis(stamps[6].createTime) > registered + 10000
    )
      fail();
    const capacity = validateHistoricalMediaRecoveryCapacity(s.capacity, owned!.start.attemptedAt, s.observedAt),
      w = s.worker.cloudRun;
    if (
      !w ||
      s.worker.buildId !== p.buildId ||
      w.projectId !== 'urm-app-staging' ||
      w.region !== 'us-central1' ||
      w.pool !== o.pool.name.split('/').at(-1) ||
      w.revision !== o.pool.revision.split('/').at(-1) ||
      w.revisionUid !== o.pool.revisionUid ||
      w.imageDigest !== p.image.split('@')[1] ||
      w.serviceAccount !== `tw-m-${p.buildId.slice(0, 20)}@urm-app-staging.iam.gserviceaccount.com` ||
      !w.instanceId ||
      capacity.allocation.pythonSHA256 !== o.image.pythonSHA256 ||
      capacity.processing.ffmpegSHA256 !== o.image.ffmpegSHA256 ||
      capacity.processing.ffprobeSHA256 !== o.image.ffprobeSHA256
    )
      fail();
    if (scope === 'phase')
      return finishPhase(k.stage, k.stage === 'running' ? `media-restored-${s.worker.instanceId}` : null);
    const actor = await read(() => o.auth.getUserByEmail(root.operatorPrincipal.email));
    if (
      actor.disabled ||
      actor.customClaims?.role !== 'admin' ||
      actor.email !== root.operatorPrincipal.email ||
      actor.uid !== k.context.actorUid
    )
      fail();
    if (proof(await snapshots()) !== proof(first)) fail();
    fresh();
    return {
      kind: 'restored-media-startup-witness-v1',
      operationId: p.operationId,
      recoveryOperationId: p.recoveryOperationId,
      planSHA256: hash(p),
      identity: `media-restored-${s.worker.instanceId}`,
      worker: s.worker,
      kernelBirthSHA256: birth.birthDigest,
      startupSHA256: digest,
      proofSHA256: proof(first),
      observedAt: new Date(began).toISOString(),
      scope: 'historical-startup-only-no-polling-or-registration-authority',
    };
  } catch {
    return fail();
  }
}
