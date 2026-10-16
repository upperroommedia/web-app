import { condition, patched, workflowInfo } from '@temporalio/workflow';

/** A deployment change is not permission to resume a provider operation. The caller
 * must carry its waiting checkpoint and any real resume signal into the next run.
 * Called only with no in-flight activity or asynchronous signal handler.
 */
export async function waitForAttentionResume(resumed: () => boolean, rotate: () => Promise<never>): Promise<void> {
  const timedWake = patched('attention-version-migration-v1');
  const changed = () => workflowInfo().targetWorkerDeploymentVersionChanged;
  if (!timedWake) {
    // Historical indefinite waits emitted no timer. Preserve their command shape;
    // a native version-change activation may still wake the command-free predicate.
    await condition(() => resumed() || changed());
    if (changed()) await rotate();
    return;
  }
  for (;;) {
    if (changed() || workflowInfo().continueAsNewSuggested) await rotate();
    if (resumed()) return;
    // Sparse wake-ups only inspect version/history pressure, never retry effects.
    await condition(() => resumed() || changed(), '5 minutes');
  }
}

/** Reject malformed continuation inputs before bypassing any effect or lifecycle start. */
export function assertAttentionContinuation(value: unknown): void {
  if (value === undefined) return;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('waiting' in value) ||
    value.waiting !== true ||
    !('resumeRequested' in value) ||
    typeof value.resumeRequested !== 'boolean'
  )
    throw new Error('Invalid attention continuation');
}
