const mockResponses: object[] = [];
const mockRequestOptions: any[] = [];
jest.mock('node:fs', () => ({
  readFileSync: (_path: string, encoding?: string) => (encoding ? 'private-mount' : Buffer.from('private-mount')),
}));
jest.mock('node:https', () => ({
  request: (options: any, callback: any) => {
    mockRequestOptions.push(options);
    const response: any = new (require('node:events').EventEmitter)();
    response.statusCode = 200;
    const request: any = new (require('node:events').EventEmitter)();
    request.setTimeout = jest.fn();
    request.destroy = (error: Error) => request.emit('error', error);
    request.end = () => {
      callback(response);
      response.emit('data', Buffer.from(JSON.stringify(mockResponses.shift())));
      response.emit('end');
    };
    return request;
  },
}));
import { loadWorkerWitness } from './worker-witness';

test('local process witnesses are unique and contain no invented cluster identity', async () => {
  const first = await loadWorkerWitness('build-sha', false, {});
  const second = await loadWorkerWitness('build-sha', false, {});
  expect(first.instanceId).not.toBe(second.instanceId);
  expect(first).toEqual({ instanceId: expect.any(String), buildId: 'build-sha' });
});
test('production account workers fail closed when trusted Pod identity is missing', async () => {
  await expect(loadWorkerWitness('build-sha', true, {})).rejects.toThrow(
    'Worker identity configuration is unavailable'
  );
});

const podEnvironment = {
  TEMPORAL_WORKER_POD_NAME: 'worker-pod',
  TEMPORAL_WORKER_POD_UID: 'pod-uid',
  TEMPORAL_WORKER_POD_NAMESPACE: 'production',
  TEMPORAL_WORKER_NODE_NAME: 'node-one',
  TEMPORAL_CLUSTER_ID: 'cluster-uid',
};
beforeEach(() => {
  mockResponses.length = 0;
  mockRequestOptions.length = 0;
});
function responses(podUid = 'pod-uid', clusterUid = 'cluster-uid') {
  mockResponses.push(
    {
      metadata: { uid: podUid, namespace: 'production' },
      spec: { nodeName: 'node-one' },
      status: { containerStatuses: [{ containerID: 'containerd://container-identity' }] },
    },
    { metadata: { uid: 'node-uid', name: 'node-one' } },
    { metadata: { uid: clusterUid } }
  );
}
test('startup binds actual Pod Node container and cluster identities through verified TLS', async () => {
  responses();
  const witness = await loadWorkerWitness('build-sha', true, podEnvironment);
  expect(witness).toMatchObject({
    podUid: 'pod-uid',
    nodeUid: 'node-uid',
    containerIds: ['containerd://container-identity'],
    clusterId: 'cluster-uid',
  });
  expect(mockRequestOptions).toHaveLength(3);
  expect(mockRequestOptions[0]).toMatchObject({
    hostname: 'kubernetes.default.svc',
    ca: expect.any(Buffer),
    headers: { authorization: 'Bearer private-mount' },
  });
  expect(mockRequestOptions[0].rejectUnauthorized).not.toBe(false);
});
test('mismatched Pod or cluster identity cannot authorize worker effects', async () => {
  responses('another-pod');
  await expect(loadWorkerWitness('build-sha', true, podEnvironment)).rejects.toThrow(
    'Worker identity does not match its Pod'
  );
  mockResponses.length = 0;
  responses('pod-uid', 'another-cluster');
  await expect(loadWorkerWitness('build-sha', true, podEnvironment)).rejects.toThrow(
    'Worker cluster identity cannot be verified'
  );
});
