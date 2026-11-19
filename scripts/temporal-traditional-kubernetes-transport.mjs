import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { advanceTraditionalKubernetesWatch, traditionalScalePatch } from './temporal-traditional-kubernetes.mjs';

const exec = promisify(execFile);
const podList = '/api/v1/namespaces/temporal-staging/pods';
const allowedReads = new Set([
  '/api/v1/namespaces/kube-system',
  '/api/v1/nodes',
  '/apis/apps/v1/namespaces/temporal-staging/deployments',
  '/apis/apps/v1/namespaces/temporal-staging/replicasets',
  podList,
  '/apis/autoscaling/v2/namespaces/temporal-staging/horizontalpodautoscalers',
]);
const nodeLease = /^\/apis\/coordination\.k8s\.io\/v1\/namespaces\/kube-node-lease\/leases\/[a-z0-9][a-z0-9.-]{0,252}$/;
const resourceVersion = /^[1-9][0-9]{0,29}$/;
const deploymentName = /^urm-worker-(controls|email|images|media|orchestration|search)-[a-f0-9]{20}$/;
const fail = () => {
  throw new Error('TRADITIONAL_KUBERNETES_TRANSPORT_UNCONFIRMED');
};

export async function createTraditionalKubernetesTransport(context) {
  if (typeof context !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,200}$/.test(context)) fail();
  const nativeConfig = await exec('kubectl', ['--context', context, 'config', 'view', '--minify', '-o', 'json'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 128 * 1024,
  });
  const cluster = JSON.parse(nativeConfig.stdout).clusters;
  if (
    !Array.isArray(cluster) ||
    cluster.length !== 1 ||
    cluster[0]?.cluster?.server !== 'https://127.0.0.1:16443' ||
    cluster[0].cluster['insecure-skip-tls-verify'] === true ||
    cluster[0].cluster['proxy-url'] ||
    !(cluster[0].cluster['certificate-authority-data'] || cluster[0].cluster['certificate-authority'])
  )
    fail();
  const transport = bindTraditionalKubernetesTransport(async (path) => {
    const { stdout } = await exec('kubectl', ['--context', context, '--request-timeout=12s', 'get', '--raw', path], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  });
  return {
    ...transport,
    async scaleOriginalToZero(original) {
      if (!deploymentName.test(original?.name ?? '')) fail();
      await exec(
        'kubectl',
        [
          '--context',
          context,
          '--request-timeout=12s',
          '--namespace',
          'temporal-staging',
          'patch',
          'deployment',
          original.name,
          '--type=json',
          '--patch',
          JSON.stringify(traditionalScalePatch(original)),
        ],
        { encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024 }
      );
    },
  };
}

/** Read-only native API transport. A failed request leaves the caller's
 * last durable cursor intact, including if Kubernetes compacted it. */
export function bindTraditionalKubernetesTransport(getRaw) {
  if (typeof getRaw !== 'function') fail();
  return {
    async read(path) {
      if (!allowedReads.has(path) && !nodeLease.test(path)) fail();
      return JSON.parse(await getRaw(path));
    },
    async readDeployment(name) {
      if (typeof name !== 'string' || !deploymentName.test(name)) fail();
      return JSON.parse(await getRaw(`/apis/apps/v1/namespaces/temporal-staging/deployments/${name}`));
    },
    async watch({ before, attemptedAt, progress }) {
      const cursor = progress?.podResourceVersion ?? before?.podResourceVersion;
      if (!resourceVersion.test(cursor ?? '')) fail();
      const query = new URLSearchParams({
        watch: 'true',
        allowWatchBookmarks: 'true',
        resourceVersion: cursor,
        timeoutSeconds: '5',
      });
      const raw = await getRaw(`${podList}?${query}`);
      if (typeof raw !== 'string' || raw.length > 8 * 1024 * 1024) fail();
      const lines = raw.split('\n').filter((line) => line.trim());
      if (lines.length > 10000) fail();
      return advanceTraditionalKubernetesWatch({
        before,
        attemptedAt,
        progress,
        watch: lines.map((line) => JSON.parse(line)),
      });
    },
  };
}
