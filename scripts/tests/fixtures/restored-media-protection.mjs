import { mediaPrivateInventoryFixture } from './media-private-inventory.mjs';
/** CONTROLLED native API reports; never production evidence or a fallback. */
export function restoredMediaProtectionFixture() {
  const f = mediaPrivateInventoryFixture(),
    service = f.options.client.connection.workflowService;
  const original = { ...service },
    name = 'urm-worker-media-staging',
    queue = 'urm-media';
  const state = { identity: null, foreign: false, normalBacklog: 0, registered: true };
  service.describeWorkerDeployment = async (r) =>
    r.deploymentName === name
      ? {
          workerDeploymentInfo: {
            name,
            routingConfig: {},
            versionSummaries: state.registered
              ? [{ deploymentVersion: { deploymentName: name, buildId: f.options.plan.buildId } }]
              : [],
          },
        }
      : original.describeWorkerDeployment(r);
  service.describeWorkerDeploymentVersion = async (r) =>
    r.deploymentVersion.deploymentName === name
      ? {
          workerDeploymentVersionInfo: {
            deploymentVersion: r.deploymentVersion,
            taskQueueInfos: [{ name: queue, type: 2 }],
          },
          versionTaskQueues: [{ name: queue, type: 2, stats: { approximateBacklogCount: state.normalBacklog } }],
        }
      : original.describeWorkerDeploymentVersion(r);
  service.listTaskQueuePartitions = async (r) =>
    r.taskQueue.name === queue
      ? { workflowTaskQueuePartitions: [{ key: queue }], activityTaskQueuePartitions: [{ key: queue }] }
      : original.listTaskQueuePartitions(r);
  service.describeTaskQueue = async (r) =>
    r.taskQueue.name === queue
      ? {
          versioningInfo: {},
          taskQueueStatus: { backlogCountHint: 0 },
          pollers:
            r.taskQueueType === 2 && state.identity
              ? [
                  {
                    identity: state.foreign ? 'foreign' : state.identity,
                    deploymentOptions: {
                      deploymentName: name,
                      buildId: f.options.plan.buildId,
                      workerVersioningMode: 2,
                    },
                  },
                ]
              : [],
        }
      : original.describeTaskQueue(r);
  return { ...f, normal: state };
}
