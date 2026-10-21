import { ApplicationFailure } from '@temporalio/common';
import { workerReadinessDigest as hash } from './readiness-probe';
const MEDIA_RECOVERY_DEPLOYMENT = 'urm-worker-media-recovery-staging';
const fail = (): never => {
  throw ApplicationFailure.nonRetryable('Private media work cannot be verified', 'MEDIA_RECOVERY_WORK_UNCONFIRMED');
};
/** Both original and current overrides must retain the exact explicit pin. */
export function mediaRecoveryPinnedVersion(value: any, expected: any) {
  if (
    !value?.pinned ||
    value.autoUpgrade ||
    value.pinned.behavior !== 1 ||
    value.pinned.deployment ||
    hash(value.pinned.version) !== hash(expected) ||
    expected?.deploymentName !== MEDIA_RECOVERY_DEPLOYMENT ||
    !/^[a-f0-9]{40}$/.test(expected?.buildId ?? '')
  )
    fail();
  return true;
}
