import {
  ActivityCancellationType,
  condition,
  continueAsNew,
  makeContinueAsNewFunc,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import { withDurableLifecycle } from '../lifecycle';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type { createBundleActivities } from '../../../../../functions/src/temporal/bundles/activities';

const controls = proxyActivities<Pick<ReturnType<typeof createBundleActivities>, 'resolveLatestBundleJob'>>({
  taskQueue: 'urm-controls',
  startToCloseTimeout: '1 minute',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { initialInterval: '1 second', maximumInterval: '1 minute', maximumAttempts: 12 },
});
const activities = proxyActivities<Omit<ReturnType<typeof createBundleActivities>, 'resolveLatestBundleJob'>>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { initialInterval: '1 second', maximumInterval: '1 minute', maximumAttempts: 12 },
});
export const requestBundleRegeneration = defineSignal<[DurableJobRef]>('requestBundleRegeneration');
/** One coordinator per project/bundle. History contains private-job references only. */
export async function bundlesWorkflow(initial: DurableJobRef): Promise<void> {
  let pending: DurableJobRef | undefined = initial;
  let latest = initial;
  let version = 0;
  const seen = new Set([initial.jobId]);
  setHandler(requestBundleRegeneration, (ref) => {
    if (ref.projectId !== initial.projectId || seen.has(ref.jobId)) return;
    seen.add(ref.jobId);
    pending = ref;
    latest = ref;
    version += 1;
  });
  for (;;) {
    // Close idle coordinators so rolling deployments can drain their pinned
    // workers. Signal-With-Start admits the next event into a fresh execution.
    if (!(await condition(() => pending !== undefined, '30 seconds'))) return;
    // Fixed window avoids starvation under continuous updates. New signals during
    // generation always queue another cycle; no arbitrary cycle cap drops work.
    await sleep('2500 milliseconds');
    const candidate = pending!;
    const generation = version;
    pending = undefined;
    const ref = await controls.resolveLatestBundleJob(candidate);
    if (ref) await withDurableLifecycle(ref, () => activities.regenerateBundle(ref));
    if (generation !== version && !pending) pending = latest;
    if (workflowInfo().continueAsNewSuggested || workflowInfo().targetWorkerDeploymentVersionChanged) {
      const rotate = workflowInfo().targetWorkerDeploymentVersionChanged
        ? makeContinueAsNewFunc<typeof bundlesWorkflow>({ initialVersioningBehavior: 'AUTO_UPGRADE' })
        : continueAsNew<typeof bundlesWorkflow>;
      await rotate(pending ?? latest);
    }
  }
}
