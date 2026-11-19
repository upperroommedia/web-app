import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { serverlessComputeSettings } from './temporal-serverless-platform.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const fail = () => {
  throw new Error('CLOUD_RUN_WORKER_COMPUTE_ATTACHMENT_UNCONFIRMED');
};
const encoding = Buffer.from('json/plain');

function payload(details) {
  return { metadata: { encoding }, data: Buffer.from(JSON.stringify(details)) };
}

function decode(value) {
  if (
    !value ||
    Object.keys(value.metadata ?? {}).join(',') !== 'encoding' ||
    !(value.metadata.encoding instanceof Uint8Array) ||
    !encoding.equals(Buffer.from(value.metadata.encoding)) ||
    !(value.data instanceof Uint8Array) ||
    value.data.length > 4096
  )
    return fail();
  return JSON.parse(Buffer.from(value.data).toString('utf8'));
}

export function observeWorkerCompute(config, binding) {
  if (
    config != null &&
    (typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some((key) => key !== 'scalingGroups'))
  )
    return fail();
  const groups = config?.scalingGroups ?? {};
  if (typeof groups !== 'object' || Array.isArray(groups)) return fail();
  const keys = Object.keys(groups);
  if (!keys.length) return 'absent';
  if (keys.length !== 1 || keys[0] !== 'default') return fail();
  const group = groups.default;
  const expected = serverlessComputeSettings(binding);
  if (
    Object.keys(group ?? {}).some((key) => !['provider', 'scaler', 'taskQueueTypes'].includes(key)) ||
    (group?.taskQueueTypes !== undefined &&
      (!Array.isArray(group.taskQueueTypes) || group.taskQueueTypes.length !== 0)) ||
    Object.keys(group?.provider ?? {})
      .sort()
      .join(',') !== 'details,type' ||
    Object.keys(group?.scaler ?? {})
      .sort()
      .join(',') !== 'details,type' ||
    group.provider.type !== expected.provider.type ||
    group.scaler.type !== expected.scaler.type ||
    !isDeepStrictEqual(decode(group.provider.details), expected.provider.details) ||
    !isDeepStrictEqual(decode(group.scaler.details), expected.scaler.details)
  )
    return fail();
  return 'exact';
}

function computeUpdate(binding, plan) {
  const { provider, scaler } = serverlessComputeSettings(binding);
  return {
    namespace: binding.namespace,
    deploymentVersion: { deploymentName: binding.deploymentName, buildId: binding.buildId },
    requestId: plan.operationId,
    identity: `urm-${binding.role}-compute-${plan.operationId}`,
    computeConfigScalingGroups: {
      default: {
        scalingGroup: {
          provider: { type: provider.type, details: payload(provider.details) },
          scaler: { type: scaler.type, details: payload(scaler.details) },
        },
        updateMask: { paths: ['provider.type', 'provider.details', 'scaler.type', 'scaler.details'] },
      },
    },
  };
}

function assertFresh(proof) {
  const now = Date.now();
  if (
    !Number.isSafeInteger(proof?.observedAt) ||
    proof.observedAt > now ||
    now - proof.observedAt > 10000 ||
    !sha256.test(proof.protectionSHA256 ?? '')
  )
    fail();
}

/**
 * The release owns persistence and the authenticated cross-provider guard.
 * Protection must check retirement, paused admission, leases, exact role
 * bindings and the immutable pool before returning its event-independent hash.
 */
export async function attachWorkerCompute({
  binding,
  client,
  operationId,
  releaseId,
  bindingDigest,
  evidenceDigest,
  observeProtection,
  save,
  authorize,
  saved,
}) {
  if (
    !uuid.test(operationId ?? '') ||
    !uuid.test(releaseId ?? '') ||
    !sha256.test(bindingDigest ?? '') ||
    !sha256.test(evidenceDigest ?? '') ||
    client.options.namespace !== binding.namespace ||
    client.connection.options?.interceptors?.length !== 0 ||
    client.connection.options?.channelArgs?.['grpc.enable_retries'] !== 0 ||
    [observeProtection, save, authorize].some((fn) => typeof fn !== 'function')
  )
    return fail();
  const plan = {
    schemaVersion: 1,
    operationId,
    releaseId,
    bindingDigest,
    evidenceDigest,
    bindingSHA256: proofDigest(binding),
    computeSHA256: proofDigest(serverlessComputeSettings(binding)),
  };
  const service = client.connection.workflowService;
  const rpc = (fn) => client.connection.withDeadline(Date.now() + 5000, fn);
  const request = computeUpdate(binding, plan);
  const readTarget = async () => {
    const { workerDeploymentVersionInfo: version } = await rpc(() =>
      service.describeWorkerDeploymentVersion({
        namespace: request.namespace,
        deploymentVersion: request.deploymentVersion,
      })
    );
    if (
      version?.deploymentVersion?.deploymentName !== binding.deploymentName ||
      version.deploymentVersion.buildId !== binding.buildId ||
      !version.currentSinceTime ||
      version.rampingSinceTime ||
      Number(version.rampPercentage ?? 0) !== 0
    )
      return fail();
    return observeWorkerCompute(version.computeConfig, binding);
  };
  const prove = async (expectedCompute) => {
    const proof = await observeProtection(expectedCompute);
    assertFresh(proof);
    return proof;
  };
  let state = saved;
  if (state) {
    const completed = state.stage === 'completed';
    const fields = completed
      ? 'attemptedAt,observedAt,outcome,plan,protectionSHA256,stage'
      : 'attemptedAt,plan,protectionSHA256,stage';
    if (
      Object.keys(state).sort().join(',') !== fields ||
      !isDeepStrictEqual(state.plan, plan) ||
      !['attempted', 'acknowledged', 'completed'].includes(state.stage) ||
      !sha256.test(state.protectionSHA256 ?? '') ||
      !Number.isSafeInteger(state.attemptedAt) ||
      state.attemptedAt <= 0 ||
      state.attemptedAt > Date.now() ||
      (completed &&
        (!Number.isSafeInteger(state.observedAt) ||
          state.observedAt < state.attemptedAt ||
          state.observedAt > Date.now() ||
          !['native-acknowledgement-and-readback', 'desired-compute-observed-after-unknown-ack'].includes(
            state.outcome
          )))
    )
      return fail();
  } else {
    const before = await prove('absent');
    if ((await readTarget()) !== 'absent') return fail();
    await authorize();
    assertFresh(before);
    state = { plan, stage: 'attempted', protectionSHA256: before.protectionSHA256, attemptedAt: Date.now() };
    await save(state);
    const atSend = await prove('absent');
    if (atSend.protectionSHA256 !== before.protectionSHA256 || (await readTarget()) !== 'absent') return fail();
    await authorize();
    assertFresh(atSend);
    let ack;
    try {
      ack = await rpc(() => service.updateWorkerDeploymentVersionComputeConfig(request));
    } catch {
      // The saved attempt is authoritative. Re-entry reads the exact version
      // and cannot send another UPDATE, even if the version is still empty.
    }
    if (ack) {
      state = { ...state, stage: 'acknowledged' };
      await save(state);
    }
  }
  if ((await readTarget()) !== 'exact') return fail();
  const after = await prove('exact');
  if (after.protectionSHA256 !== state.protectionSHA256) return fail();
  await authorize();
  assertFresh(after);
  if (state.stage === 'completed') return state;
  state = {
    ...state,
    stage: 'completed',
    observedAt: after.observedAt,
    outcome:
      state.stage === 'acknowledged'
        ? 'native-acknowledgement-and-readback'
        : 'desired-compute-observed-after-unknown-ack',
  };
  await save(state);
  return state;
}
