import { randomUUID } from 'node:crypto';
import { proofDigest as hash } from '../../temporal-release-runtime.mjs';
/** CONTROLLED provenance records only. These do not pass the production episode
 * collector and cannot stand in for native Workflow/image/artifact evidence. */
export function controlledRecoveryCapsuleFacts(next) {
  const p = next.plan,
    id = p.operationId,
    nonce = randomUUID();
  const cycle = { plan: p, stage: 'prepared', prepared: next.prepared, diagnostic: next.diagnostic, start: next.start };
  const intent = {
    schemaVersion: 1,
    stage: 'attempted',
    operationId: id,
    planSHA256: hash(p),
    cycleSHA256: hash(cycle),
    poolSHA256: hash(next.start.pool),
    preparedSHA256: hash(next.prepared),
    workflowId: `media-recovery-${id}`,
    workflowType: 'MediaRecoveryProbe',
    taskQueue: 'urm-media-kernel-recovery',
    inputSHA256: hash({ operationId: id, startNonce: nonce }),
    nonce,
    deploymentVersion: { deploymentName: 'urm-worker-media-recovery-staging', buildId: p.buildId },
    attemptedAt: p.createdAt,
    expiresAt: p.expiresAt,
  };
  const ack = {
    schemaVersion: 1,
    stage: 'confirmed',
    operationId: id,
    intentSHA256: hash(intent),
    poolSHA256: hash(next.start.pool),
    runId: randomUUID(),
    recordedAt: p.createdAt,
    confirmedAt: p.createdAt,
    nativeStartSHA256: 'a'.repeat(64),
    ack: 'native-start-response',
  };
  const facts = Object.fromEntries(
    [
      'Startup',
      'OriginalReady',
      'OriginalSignal',
      'OriginalDeath',
      'Work',
      'ReplacementIntent',
      'ReplacementStartup',
      'ReplacementAdoption',
      'ReplacementCompleted',
      'ReplacementStop',
    ].map((k) => [k, { CONTROLLED_PROVENANCE_ONLY: k }])
  );
  facts.Start = ack;
  facts.Kernel = { stage: 'closed', close: { signal: 'SIGKILL', descendantsAbsent: true } };
  facts.ReplacementKernel = { stage: 'closed', close: { code: 0, signal: null, descendantsAbsent: true } };
  return { intent, facts };
}

export const controlledCapsuleOperatorIdentity = {
  descriptorSHA256: 'a'.repeat(64),
  operatorClosureDigest: 'b'.repeat(64),
  operatorCommit: 'c'.repeat(40),
  operatorRoot: '/CONTROLLED',
  resourceBinding: { CONTROLLED: true },
  runtimeCommit: 'd'.repeat(40),
  runtimePins: { CONTROLLED: true },
  runtimeRoot: '/CONTROLLED',
};
