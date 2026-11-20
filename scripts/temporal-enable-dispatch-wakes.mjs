import { setTimeout as wait } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { assertNativeSnapshot, nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';
import { dispatchDiagnosticCompletionPath } from './temporal-diagnostic-wake.mjs';
import { dispatchWakePlan } from './temporal-dispatch-wake-plan.mjs';
import { dispatchWakeIdentity } from './temporal-stop-dispatch-wake.mjs';
import { eventarcNativeOperation, recoverEventarcCreateAudit } from './temporal-eventarc-create-audit.mjs';

const fail = () => {
  throw new Error('STAGING_DISPATCH_WAKES_UNCONFIRMED');
};
const eventarc = 'https://eventarc.googleapis.com/v1/';
const scheduler = 'https://cloudscheduler.googleapis.com/v1/';
const triggerSurfaces = ['outbox-trigger', 'commands-trigger'];
const operationKey = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** The two business triggers get a new origin. The diagnostic's same paused
 * Scheduler job is resumed once. Every uncertain write is read back only. */
export async function enableStagingDispatchWakes(options) {
  const {
    platform,
    api,
    verify,
    assertAuthority,
    verifyConfiguration,
    save,
    saved,
    creator,
    operationId,
    releaseId,
    evidenceDigest,
    schedulerCreation,
    diagnostic,
  } = options;
  const creation = schedulerCreation?.identityState;
  const original = creation?.plan;
  const diagnosticScheduler = diagnostic?.wakes?.find(({ surface }) => surface === 'scheduler');
  if (
    platform.firebaseProjectId !== 'urm-app-staging' ||
    platform.workerHosting !== 'cloud-run' ||
    !diagnosticScheduler ||
    diagnosticScheduler.creation.dataDigest !== proofDigest(schedulerCreation) ||
    diagnostic.releaseId !== releaseId ||
    diagnostic.evidenceDigest !== evidenceDigest ||
    diagnostic.buildId !== platform.workerBuildId ||
    diagnostic.image !== platform.workerImage ||
    schedulerCreation.operationId !== diagnostic.operationId ||
    schedulerCreation.releaseId !== releaseId ||
    schedulerCreation.bindingDigest !== diagnostic.bindingDigest ||
    creation.stage !== 'completed' ||
    original?.surface !== 'scheduler' ||
    !isDeepStrictEqual(creation.acknowledgedResource, creation.resource) ||
    ![api, verify, assertAuthority, verifyConfiguration, save].every((fn) => typeof fn === 'function')
  )
    fail();
  const derivedScheduler = dispatchWakePlan({ ...options, operationId: diagnostic.operationId, surface: 'scheduler' });
  if (!isDeepStrictEqual(original, derivedScheduler)) fail();
  const triggers = triggerSurfaces.map((surface) => dispatchWakePlan({ ...options, surface }));
  const plan = {
    schemaVersion: 1,
    operationId,
    releaseId,
    evidenceDigest,
    role: 'dispatch',
    creator,
    diagnosticOperationId: diagnostic.operationId,
    diagnosticSHA256: proofDigest(diagnostic),
    triggers,
    schedulerOrigin: creation.resource,
  };
  let state = saved;
  if (state && (!isDeepStrictEqual(state.plan, plan) || !['planned', 'completed'].includes(state.stage))) fail();
  const put = async (next) => {
    await save(next);
    state = next;
  };
  if (!state) await put({ plan, stage: 'planned', wakes: {} });

  const checkScheduler = async () => {
    const job = await api(scheduler + original.body.name);
    if (!isDeepStrictEqual(dispatchWakeIdentity(original, job), creation.resource)) fail();
    return job;
  };
  const observeTrigger = async (trigger, row) => {
    const name = eventarcNativeOperation(row.nativeOperation);
    const deadline = Date.now() + 30_000;
    let result;
    do {
      await assertAuthority();
      result = await api(eventarc + name);
      if (eventarcNativeOperation(result?.name) !== name || result.error) fail();
      if (result.done === true) break;
      if ((result.done !== undefined && result.done !== false) || Date.now() >= deadline) fail();
      await wait(1000);
    } while (Date.now() < deadline);
    if (result.done !== true) fail();
    const identity = dispatchWakeIdentity(trigger, result.response);
    const current = dispatchWakeIdentity(trigger, await api(eventarc + trigger.body.name));
    if (current.uid !== identity.uid) fail();
    return current;
  };
  const setWake = (surface, row) => put({ ...state, wakes: { ...state.wakes, [surface]: row } });
  await verify();
  for (const trigger of triggers) {
    const { surface, body } = trigger;
    let row = state.wakes[surface];
    if (!row) {
      await verify();
      if ((await checkScheduler()).state !== 'PAUSED') fail();
      try {
        await api(eventarc + body.name);
        fail();
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
      row = { stage: 'attempted', attemptedAt: new Date().toISOString() };
      await setWake(surface, row);
      await verify();
      const resourceId = body.name.split('/').at(-1);
      const parent = body.name.slice(0, body.name.lastIndexOf('/'));
      const ack = await api(
        `${eventarc}${parent}?triggerId=${encodeURIComponent(resourceId)}`,
        'POST',
        body,
        assertAuthority
      );
      row = { ...row, stage: 'acknowledged', nativeOperation: eventarcNativeOperation(ack?.name) };
      await setWake(surface, row);
    }
    if (row.stage === 'attempted') {
      await verify();
      const recovered = await recoverEventarcCreateAudit({
        creation: trigger,
        creator,
        attemptedAt: row.attemptedAt,
        api,
      });
      row = { ...row, ...recovered, stage: 'acknowledged' };
      await setWake(surface, row);
    }
    const identity = await observeTrigger(trigger, row);
    if (row.stage === 'completed') {
      if (identity.uid !== row.identity.uid) fail();
    } else {
      if (row.stage !== 'acknowledged') fail();
      await setWake(surface, { ...row, stage: 'completed', identity });
    }
  }

  await verify();
  if (!state.scheduler) {
    if ((await checkScheduler()).state !== 'PAUSED') fail();
    await put({ ...state, scheduler: { stage: 'attempted', attemptedAt: new Date().toISOString() } });
    await verify();
    if ((await checkScheduler()).state !== 'PAUSED') fail();
    const response = await api(`${scheduler}${original.body.name}:resume`, 'POST', undefined, assertAuthority);
    if (!isDeepStrictEqual(dispatchWakeIdentity(original, response), creation.resource) || response.state !== 'ENABLED')
      fail();
    await put({ ...state, scheduler: { ...state.scheduler, stage: 'acknowledged' } });
  }
  if (
    !['attempted', 'acknowledged', 'completed'].includes(state.scheduler.stage) ||
    (await checkScheduler()).state !== 'ENABLED'
  )
    fail();
  const live = await verifyConfiguration();
  if (
    live.service?.revision !== diagnostic.observations[0]?.serviceRevision ||
    live.scheduler?.name !== original.body.name ||
    live.scheduler.userUpdateTime !== creation.resource.userUpdateTime ||
    live.triggers?.length !== triggers.length ||
    triggers.some(
      ({ body, surface }) =>
        !live.triggers.some(({ name, uid }) => name === body.name && uid === state.wakes[surface].identity.uid)
    )
  )
    fail();
  await verify();
  if (state.stage !== 'completed') {
    const outcome =
      state.scheduler.stage === 'acknowledged' ? 'acknowledged-and-observed' : 'enabled-observed-after-unknown-ack';
    await put({
      ...state,
      stage: 'completed',
      scheduler: { ...state.scheduler, stage: 'completed', outcome },
      configuration: live,
    });
  }
  assertStagingDispatchWakes(
    { operationId, releaseId, identityState: state },
    {
      operationId,
      releaseId,
      platform,
      evidenceDigest,
      live,
    }
  );
  return state;
}

/** Release readiness joins the owned activation to current configuration. */
export function assertStagingDispatchWakes(receipt, { releaseId, platform, evidenceDigest, operationId, live }) {
  const state = receipt?.identityState;
  const original = state?.configuration;
  if (
    receipt?.operationId !== operationId ||
    receipt.releaseId !== releaseId ||
    state?.stage !== 'completed' ||
    state.plan?.operationId !== operationId ||
    state.plan.releaseId !== releaseId ||
    state.plan.evidenceDigest !== evidenceDigest ||
    state.scheduler?.stage !== 'completed' ||
    state.plan.schedulerOrigin?.name !== live?.scheduler?.name ||
    !Number.isFinite(Date.parse(state.plan.schedulerOrigin?.userUpdateTime ?? '')) ||
    state.plan.schedulerOrigin.userUpdateTime !== live.scheduler.userUpdateTime ||
    live?.buildId !== platform.workerBuildId ||
    live.service?.image !== platform.workerImage ||
    !original ||
    live.service.uid !== original.service?.uid ||
    live.service.revision !== original.service?.revision ||
    live.service.revisionUid !== original.service?.revisionUid ||
    live.directInvokerPolicySHA256 !== original.directInvokerPolicySHA256 ||
    (original.scheduler?.configurationDigestVersion === 2 &&
      (live.scheduler.configurationDigestVersion !== 2 ||
        !/^[a-f0-9]{64}$/.test(original.scheduler.configurationSHA256 ?? '') ||
        live.scheduler.configurationSHA256 !== original.scheduler.configurationSHA256)) ||
    !Array.isArray(live.triggers) ||
    live.triggers.length !== triggerSurfaces.length ||
    triggerSurfaces.some((surface) => {
      const own = state.wakes?.[surface];
      return (
        own?.stage !== 'completed' ||
        !live.triggers.some((row) => row.name === own.identity?.name && row.uid === own.identity?.uid)
      );
    })
  )
    fail();
}

/** Rejoin the exact diagnostic and service activation used when the live
 * business wakes were enabled. A same-name replacement cannot supply lineage. */
export async function readStagingDispatchWakeAuthority(db, context, transaction) {
  const { operationId, releaseId, platform, evidenceDigest, live } = context;
  if (db.projectId !== 'urm-app-staging' || db.databaseId !== '(default)' || !operationKey.test(operationId ?? ''))
    fail();
  const immutable = (snapshot) => snapshot.exists && snapshot.createTime?.isEqual(snapshot.updateTime);
  const wakeRef = db.doc(`_control/temporalCloudBusinessDispatchWakes-${operationId}`);
  const read = async (tx) => {
    const wakes = await tx.get(wakeRef);
    if (!immutable(wakes)) fail();
    const receipt = wakes.data();
    assertStagingDispatchWakes(receipt, context);
    const { diagnosticOperationId, diagnosticSHA256 } = receipt.identityState.plan;
    if (!operationKey.test(diagnosticOperationId ?? '') || diagnosticOperationId === operationId) fail();
    const diagnosticRef = db.doc(dispatchDiagnosticCompletionPath(diagnosticOperationId));
    const diagnostic = await tx.get(diagnosticRef);
    if (!immutable(diagnostic)) fail();
    const result = diagnostic.data();
    if (
      result.schemaVersion !== 1 ||
      result.operationId !== diagnosticOperationId ||
      result.releaseId !== releaseId ||
      result.evidenceDigest !== evidenceDigest ||
      result.buildId !== platform.workerBuildId ||
      result.image !== platform.workerImage ||
      result.scope !== 'original diagnostic delivery, retry reconciliation and resource cleanup only' ||
      proofDigest(result) !== diagnosticSHA256 ||
      !operationKey.test(result.activationOperationId ?? '') ||
      !(
        result.observations?.length === 3 &&
        result.observations.every((row) => row?.serviceRevision === live.service.revision)
      )
    )
      fail();
    const activationRef = db.doc(`_control/temporalCloudDispatchActivation-${result.activationOperationId}`);
    const activation = await tx.get(activationRef);
    if (
      !immutable(activation) ||
      activation.get('operationId') !== result.activationOperationId ||
      activation.get('releaseId') !== releaseId ||
      activation.get('identityState.stage') !== 'completed' ||
      activation.get('identityState.plan.evidenceDigest') !== evidenceDigest ||
      activation.get('identityState.service.revision') !== live.service.revision
    )
      fail();
    assertNativeSnapshot(result.activation, activation);
    return [wakes, diagnostic, activation].map((snapshot) => ({
      path: snapshot.ref.path,
      proof: nativeSnapshotProof(snapshot),
    }));
  };
  return transaction ? read(transaction) : db.runTransaction(read, { readOnly: true });
}
