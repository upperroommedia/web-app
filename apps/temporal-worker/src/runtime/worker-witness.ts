import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';

export interface WorkerWitness {
  instanceId: string;
  buildId: string;
  podUid?: string;
  podName?: string;
  namespace?: string;
  clusterId?: string;
  nodeUid?: string;
  nodeName?: string;
  containerIds?: string[];
}
const serviceAccountDirectory = '/var/run/secrets/kubernetes.io/serviceaccount';
/** Kubernetes identities are private execution witnesses, never workflow arguments. */
export async function loadWorkerWitness(buildId: string, required: boolean, env = process.env): Promise<WorkerWitness> {
  const witness: WorkerWitness = { instanceId: randomUUID(), buildId };
  if (!required && !env.TEMPORAL_WORKER_POD_UID) return witness;
  const podName = env.TEMPORAL_WORKER_POD_NAME;
  const podUid = env.TEMPORAL_WORKER_POD_UID;
  const namespace = env.TEMPORAL_WORKER_POD_NAMESPACE;
  const nodeName = env.TEMPORAL_WORKER_NODE_NAME;
  const configuredClusterId = env.TEMPORAL_CLUSTER_ID;
  if (![podName, podUid, namespace, nodeName].every((value) => value && /^[A-Za-z0-9_.:-]{1,253}$/.test(value)))
    throw new Error('Worker identity configuration is unavailable');
  const token = readFileSync(`${serviceAccountDirectory}/token`, 'utf8').trim();
  const ca = readFileSync(`${serviceAccountDirectory}/ca.crt`);
  const fetch = (path: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: 'kubernetes.default.svc',
          port: 443,
          path,
          ca,
          method: 'GET',
          signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        },
        (response) => {
          let size = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
              req.destroy(new Error('Worker identity response exceeded limit'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              if (response.statusCode !== 200) throw new Error('Worker identity cannot be verified');
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              reject(new Error('Worker identity cannot be verified'));
            }
          });
          response.on('error', () => reject(new Error('Worker identity cannot be verified')));
        }
      );
      req.setTimeout(5000, () => req.destroy(new Error('Worker identity lookup timed out')));
      req.on('error', () => reject(new Error('Worker identity cannot be verified')));
      req.end();
    });
  const pod = await fetch(`/api/v1/namespaces/${encodeURIComponent(namespace!)}/pods/${encodeURIComponent(podName!)}`);
  if (pod.metadata?.uid !== podUid || pod.metadata?.namespace !== namespace || pod.spec?.nodeName !== nodeName)
    throw new Error('Worker identity does not match its Pod');
  const node = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeName!)}`);
  const cluster = await fetch('/api/v1/namespaces/kube-system');
  const clusterId = cluster.metadata?.uid;
  if (
    typeof clusterId !== 'string' ||
    !/^[A-Za-z0-9-]{1,253}$/.test(clusterId) ||
    (configuredClusterId && configuredClusterId !== clusterId)
  )
    throw new Error('Worker cluster identity cannot be verified');
  const containerIds = (pod.status?.containerStatuses ?? [])
    .map((status: any) => status.containerID)
    .filter((id: unknown): id is string => typeof id === 'string' && /^[a-z][a-z0-9+.-]*:\/\/[^\s]{1,256}$/.test(id));
  if (node.metadata?.name !== nodeName || typeof node.metadata?.uid !== 'string' || !containerIds.length)
    throw new Error('Worker runtime identity is incomplete');
  return { ...witness, podName, podUid, namespace, nodeName, nodeUid: node.metadata.uid, clusterId, containerIds };
}
