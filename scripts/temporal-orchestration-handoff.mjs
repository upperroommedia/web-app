import { proofDigest } from './temporal-release-runtime.mjs';
import { traditionalDeployment } from './temporal-traditional-worker-handoff.mjs';

const namespace = 'urm-app-staging.qwejt';
const commit = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = () => {
  throw new Error('ORCHESTRATION_HANDOFF_UNCONFIRMED');
};
const same = (a, b) => proofDigest(a) === proofDigest(b);
function nativeToken(value) {
  if (!(value instanceof Uint8Array) || !value.length || value.length > 4096) fail();
  return Buffer.from(value).toString('base64');
}

function assertFresh(proof) {
  const now = Date.now();
  if (
    !Number.isSafeInteger(proof?.observedAt) ||
    proof.observedAt > now ||
    now - proof.observedAt > 10000 ||
    !sha256.test(proof.immutableSHA256 ?? '') ||
    !sha256.test(proof.protectedWorkSHA256 ?? '')
  )
    fail();
}

/** Read replay input without exporting raw histories to an operator receipt. */
export async function readOrchestrationProtectedHistory(client, { workflowId, runId }) {
  if (
    client.options.namespace !== namespace ||
    typeof workflowId !== 'string' ||
    !workflowId ||
    !uuid.test(runId ?? '')
  )
    fail();
  const execution = { workflowId, runId };
  const service = client.connection.workflowService;
  const deadline = Date.now() + 15000;
  const call = (fn) => {
    if (Date.now() >= deadline) fail();
    return client.connection.withDeadline(Math.min(deadline, Date.now() + 5000), fn);
  };
  const describe = async () => {
    const view = await call(() => service.describeWorkflowExecution({ namespace, execution }));
    const info = view.workflowExecutionInfo;
    if (
      info?.status !== 1 ||
      info.execution?.workflowId !== workflowId ||
      info.execution.runId !== runId ||
      view.pendingWorkflowTask ||
      view.pendingActivities?.length ||
      view.pendingChildren?.length ||
      view.pendingNexusOperations?.length
    )
      fail();
    const length = Number(info.historyLength);
    if (!Number.isSafeInteger(length) || length < 1 || length > 50000) fail();
    return length;
  };
  const length = await describe();
  const events = [],
    seen = new Set();
  let cursor;
  do {
    const response = await call(() =>
      service.getWorkflowExecutionHistory({
        namespace,
        execution,
        maximumPageSize: 1000,
        ...(cursor ? { nextPageToken: cursor } : {}),
      })
    );
    if (!Array.isArray(response.history?.events) || !response.history.events.length) fail();
    for (const event of response.history.events) {
      if (event.eventId?.toString() !== String(events.length + 1) || events.length >= length) fail();
      events.push(event);
    }
    if (
      response.nextPageToken != null &&
      !(response.nextPageToken instanceof Uint8Array) &&
      !(Array.isArray(response.nextPageToken) && response.nextPageToken.length === 0)
    )
      fail();
    cursor = response.nextPageToken?.length ? response.nextPageToken : undefined;
    if (cursor) {
      const key = Buffer.from(cursor).toString('base64');
      if (seen.has(key) || seen.size >= 50) fail();
      seen.add(key);
    }
  } while (cursor);
  if (events.length !== length || (await describe()) !== length) fail();
  if (Buffer.byteLength(JSON.stringify(events)) > 20 * 1024 * 1024) fail();
  return { events };
}

/** The caller proves immutable image replay, the prepared pool, paused
 * release and all independent predecessor routes. This adapter owns the
 * single compare-token call on the shared deployment and its native receipt. */
export async function handoffOrchestration({
  client,
  buildId,
  previousBuildId,
  image,
  releaseId,
  operationId,
  bindingDigest,
  handoffPlanSHA256,
  capture,
  authorizeMutation,
  save,
  saved,
}) {
  if (
    !commit.test(buildId ?? '') ||
    !commit.test(previousBuildId ?? '') ||
    buildId === previousBuildId ||
    !/^us-central1-docker\.pkg\.dev\/urm-app-staging\/urm-temporal\/worker@sha256:[a-f0-9]{64}$/.test(image ?? '') ||
    !uuid.test(releaseId ?? '') ||
    !uuid.test(operationId ?? '') ||
    !sha256.test(bindingDigest ?? '') ||
    !sha256.test(handoffPlanSHA256 ?? '') ||
    client.options.namespace !== namespace ||
    client.connection.options?.interceptors?.length !== 0 ||
    client.connection.options?.channelArgs?.['grpc.enable_retries'] !== 0 ||
    [capture, authorizeMutation, save].some((fn) => typeof fn !== 'function')
  )
    fail();
  const plan = {
    schemaVersion: 1,
    namespace,
    deploymentName: traditionalDeployment,
    buildId,
    previousBuildId,
    image,
    releaseId,
    operationId,
    bindingDigest,
    handoffPlanSHA256,
  };
  const version = (id) => ({ deploymentName: traditionalDeployment, buildId: id });
  const service = client.connection.workflowService;
  const rpc = (fn) => client.connection.withDeadline(Date.now() + 5000, fn);
  const readTarget = async (expected) => {
    const { workerDeploymentInfo: info, conflictToken } = await rpc(() =>
      service.describeWorkerDeployment({ namespace, deploymentName: traditionalDeployment })
    );
    const route = info?.routingConfig;
    if (
      info?.name !== traditionalDeployment ||
      !same(route?.currentDeploymentVersion, version(expected)) ||
      route.rampingDeploymentVersion ||
      Number(route.rampingVersionPercentage ?? 0) !== 0
    )
      fail();
    return { token: nativeToken(conflictToken), changedAt: route.currentVersionChangedTime };
  };
  let state = saved;
  const put = async (next) => {
    await save(next);
    state = next;
  };
  if (state != null && (!same(state.plan, plan) || !['attempted', 'acknowledged', 'completed'].includes(state.stage)))
    fail();
  if (!state) {
    const [native, route] = await Promise.all([capture('before'), readTarget(previousBuildId)]);
    assertFresh(native);
    const inventory = native.preHandoffInventory;
    if (
      !inventory ||
      !Number.isSafeInteger(inventory.observedAt) ||
      inventory.observedAt > native.observedAt ||
      native.observedAt - inventory.observedAt > 10000 ||
      !sha256.test(inventory.digest ?? '') ||
      !Array.isArray(inventory.versions) ||
      !inventory.versions.some((v) => v.buildId === previousBuildId && v.active) ||
      !inventory.versions.some((v) => v.buildId === buildId && !v.active && !v.computeAttached)
    )
      fail();
    await authorizeMutation();
    assertFresh(native);
    const attemptedAt = Date.now();
    await put({
      plan,
      stage: 'attempted',
      attemptedAt,
      originalToken: route.token,
      immutableSHA256: native.immutableSHA256,
      protectedWorkSHA256: native.protectedWorkSHA256,
      preHandoffInventory: { observedAt: inventory.observedAt, digest: inventory.digest, versions: inventory.versions },
    });
    const [final, latest] = await Promise.all([capture('before'), readTarget(previousBuildId)]);
    assertFresh(final);
    if (
      final.immutableSHA256 !== native.immutableSHA256 ||
      final.protectedWorkSHA256 !== native.protectedWorkSHA256 ||
      final.preHandoffInventory?.digest !== inventory.digest ||
      latest.token !== route.token
    )
      fail();
    await authorizeMutation();
    assertFresh(final);
    let ack;
    try {
      ack = await rpc(() =>
        service.setWorkerDeploymentCurrentVersion({
          namespace,
          deploymentName: traditionalDeployment,
          buildId,
          conflictToken: Buffer.from(state.originalToken, 'base64'),
          identity: `urm-orchestration-handoff-${operationId}`,
        })
      );
    } catch {
      // Only native readback is permitted after this attempt, including if the
      // unchanged old Current is observed.
    }
    if (ack) await put({ ...state, stage: 'acknowledged', acknowledgedToken: nativeToken(ack.conflictToken) });
  }
  if (
    !Number.isSafeInteger(state.attemptedAt) ||
    state.attemptedAt > Date.now() ||
    !sha256.test(state.immutableSHA256 ?? '') ||
    !sha256.test(state.preHandoffInventory?.digest ?? '')
  )
    fail();
  const [observed, route] = await Promise.all([capture('after'), readTarget(buildId)]);
  assertFresh(observed);
  const handoffAt = Math.ceil(Number(route.changedAt?.seconds) * 1000 + Number(route.changedAt?.nanos ?? 0) / 1e6);
  if (
    !Number.isSafeInteger(handoffAt) ||
    handoffAt < state.attemptedAt ||
    handoffAt > observed.observedAt ||
    state.preHandoffInventory.observedAt >= handoffAt ||
    observed.immutableSHA256 !== state.immutableSHA256 ||
    (state.acknowledgedToken && route.token !== state.acknowledgedToken)
  )
    fail();
  await authorizeMutation();
  assertFresh(observed);
  if (state.stage === 'completed') {
    if (state.handoffAt !== handoffAt || state.finalToken !== route.token) fail();
    return state;
  }
  await put({
    ...state,
    stage: 'completed',
    handoffAt,
    finalToken: route.token,
    outcome:
      state.stage === 'acknowledged'
        ? 'native-acknowledgement-and-readback'
        : 'desired-routing-observed-after-unknown-ack',
  });
  return state;
}
