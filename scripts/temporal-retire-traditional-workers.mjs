import { proofDigest } from './temporal-release-runtime.mjs';
import {
  readTraditionalRetirementAuthority,
  saveTraditionalRetirementCheckpoint,
} from './temporal-retirement-checkpoint.mjs';
import {
  confirmTraditionalKubernetesRetired,
  observeTraditionalKubernetes,
} from './temporal-traditional-kubernetes.mjs';

const digest = /^[a-f0-9]{64}$/;
const fail = () => {
  throw new Error('TRADITIONAL_WORKER_RETIREMENT_UNCONFIRMED');
};

function assertFresh(proof) {
  const now = Date.now();
  if (
    !Number.isSafeInteger(proof?.observedAt) ||
    proof.observedAt > now ||
    now - proof.observedAt > 15000 ||
    !digest.test(proof.protectionSHA256 ?? '') ||
    !digest.test(proof.temporalSHA256 ?? '')
  )
    fail();
}

function checkController(row, original, scaled) {
  if (
    row?.kind !== 'Deployment' ||
    row.apiVersion !== 'apps/v1' ||
    row.metadata?.namespace !== 'temporal-staging' ||
    row.metadata.name !== original.name ||
    row.metadata.uid !== original.uid ||
    row.metadata.deletionTimestamp ||
    row.metadata.generation !== original.generation + Number(scaled) ||
    (!scaled && row.metadata.resourceVersion !== original.resourceVersion) ||
    row.spec?.replicas !== (scaled ? 0 : original.desired) ||
    proofDigest(row.spec.template) !== original.templateSHA256
  )
    fail();
}

/**
 * Runs only with the owning release's journal, live routing/workload guard
 * and native source-bound transport. Re-entry never resubmits an attempted
 * patch and keeps the old Pod watch cursor even if the API compacted it.
 */
export async function retireTraditionalWorkers({
  operationId,
  releaseId,
  bindingDigest,
  authority,
  transport,
  observeProtection,
  authorizeMutation,
  save,
  saved,
}) {
  if (![observeProtection, authorizeMutation, save].every((fn) => typeof fn === 'function')) fail();
  let state = saved;
  const put = async (next) => {
    await save(next);
    state = next;
  };
  const verify = async (phase, before) => {
    const observation = await observeProtection(phase, before);
    assertFresh(observation);
    if (state && observation.protectionSHA256 !== state.plan.protectionSHA256) fail();
    return observation;
  };
  if (!state) {
    const before = await observeTraditionalKubernetes(transport.read, authority);
    const protection = await verify('retiring', before);
    await authorizeMutation();
    assertFresh(protection);
    const plan = {
      schemaVersion: 1,
      operationId,
      releaseId,
      bindingDigest,
      before,
      protectionSHA256: protection.protectionSHA256,
    };
    await put({ plan, stage: 'planned', attempts: {} });
  }
  if (
    state.plan?.operationId !== operationId ||
    state.plan.releaseId !== releaseId ||
    state.plan.bindingDigest !== bindingDigest ||
    !['planned', 'retiring', 'completed'].includes(state.stage)
  )
    fail();
  const { before } = state.plan;
  if (
    before.clusterUid !== authority.clusterUid ||
    before.nodeUid !== authority.nodeUid ||
    before.nodeName !== authority.nodeName ||
    proofDigest(before.builds) !== proofDigest([...authority.builds].sort())
  )
    fail();
  if (state.stage === 'completed') return state;
  for (const original of before.deployments.filter((row) => row.desired > 0)) {
    const prior = state.attempts[original.uid];
    if (prior) {
      checkController(await transport.readDeployment(original.name), original, true);
      continue;
    }
    const proof = await verify('retiring', before);
    checkController(await transport.readDeployment(original.name), original, false);
    await authorizeMutation();
    assertFresh(proof);
    const attempts = {
      ...state.attempts,
      [original.uid]: {
        attemptedAt: Date.now(),
        resourceVersion: original.resourceVersion,
      },
    };
    const watch = state.watch ?? {
      beforeSHA256: before.digest,
      podResourceVersion: before.podResourceVersion,
      pods: {},
    };
    await put({ ...state, stage: 'retiring', attempts, watch });
    const atSend = await verify('retiring', before);
    await authorizeMutation();
    assertFresh(atSend);
    try {
      await transport.scaleOriginalToZero(original);
    } catch {
      // No second request. Reconcile only the original object's native state.
    }
    checkController(await transport.readDeployment(original.name), original, true);
  }
  const attemptedAt = Math.min(...Object.values(state.attempts).map((attempt) => attempt.attemptedAt));
  // Collect and commit any exit records first so a still-reconciling
  // Deployment or a failed native routing read cannot lose them.
  const progress = await transport.watch({ before, attemptedAt, progress: state.watch });
  if (proofDigest(progress) !== proofDigest(state.watch)) await put({ ...state, watch: progress });
  const after = await observeTraditionalKubernetes(transport.read, authority);
  // A fresh List resourceVersion may be beyond the last streamed event.
  // Resume from the original watch cursor until the native watch covers it.
  const final = await transport.watch({ before, attemptedAt, progress: state.watch });
  if (proofDigest(final) !== proofDigest(state.watch)) await put({ ...state, watch: final });
  const receipt = confirmTraditionalKubernetesRetired({ before, after, attemptedAt, progress: state.watch });
  const proof = await verify('retired', before);
  await authorizeMutation();
  assertFresh(proof);
  await put({ ...state, stage: 'completed', receipt: { ...receipt, temporalSHA256: proof.temporalSHA256 } });
  return state;
}

/** Join the native controller to the real release journal. The caller keeps
 * the existing release lock on every ambiguous checkpoint write. */
export async function retireTraditionalWorkersUnderRelease({
  firestore,
  config,
  ownedOperation,
  expectedAuthority,
  operationId,
  bindingDigest,
  authority,
  transport,
  observeNative,
  markPending,
  updateOwnedOperation,
}) {
  if (![observeNative, markPending, updateOwnedOperation].every((fn) => typeof fn === 'function')) fail();
  const repository = { firestore, config, ownedOperation, expectedAuthority, operationId, bindingDigest };
  const initial = await readTraditionalRetirementAuthority(repository, {
    onSaved: (saved) => {
      if (saved) markPending(true);
    },
  });
  const verifyAuthority = async () => {
    const current = await readTraditionalRetirementAuthority(repository);
    if (current.workSHA256 !== initial.workSHA256) fail();
    return current.workSHA256;
  };
  const result = await retireTraditionalWorkers({
    operationId,
    releaseId: config.releaseId,
    bindingDigest,
    authority,
    transport,
    saved: initial.saved,
    observeProtection: async (phase, before) => {
      const [native, workSHA256] = await Promise.all([observeNative(phase, before), verifyAuthority()]);
      assertFresh(native);
      return { ...native, protectionSHA256: proofDigest({ native: native.protectionSHA256, workSHA256 }) };
    },
    authorizeMutation: verifyAuthority,
    save: async (next) => {
      markPending(true);
      repository.ownedOperation = await saveTraditionalRetirementCheckpoint({ ...repository, next });
      updateOwnedOperation(repository.ownedOperation);
    },
  });
  if (result.stage !== 'completed') fail();
  markPending(false);
  return result;
}
