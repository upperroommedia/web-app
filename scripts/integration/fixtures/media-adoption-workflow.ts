import { proxyActivities } from '@temporalio/workflow';

// Test-only Workflow: no publishing, provider or business-admission authority.
const { acquireMedia } = proxyActivities<{
  acquireMedia(ref: unknown): Promise<{ kind: string }>;
}>({
  taskQueue: 'owned-media-adoption',
  startToCloseTimeout: '20 seconds',
  heartbeatTimeout: '3 seconds',
  retry: { initialInterval: '1 second', maximumAttempts: 2 },
});

export async function MediaArtifactAdoptionProbe(ref: unknown): Promise<{ kind: string }> {
  return acquireMedia(ref);
}
