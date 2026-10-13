#!/usr/bin/env node
// Offline single-node bootstrap output; no cloud or host mutations.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { versions } from './temporal-platform.mjs';

export function renderSingleVmBootstrap({ projectId, instanceName, instanceId, privateIp }) {
  const environment = { 'urm-app-staging': 'staging', 'urm-app': 'production' }[projectId];
  if (
    !environment ||
    instanceName !== `urm-temporal-${environment}` ||
    !/^\d+$/.test(instanceId ?? '') ||
    isIP(privateIp) !== 4 ||
    !/^10\./.test(privateIp) ||
    /^10\.(42|43)\./.test(privateIp)
  )
    throw new Error('Exact reviewed project/instance identity and nonoverlapping private VM IPv4 required');
  const namespace = `temporal-${environment}`;
  return {
    'k3s-config.json': {
      'node-name': instanceName,
      'bind-address': privateIp,
      'advertise-address': privateIp,
      'node-ip': privateIp,
      'tls-san': [privateIp, '127.0.0.1'],
      'write-kubeconfig-mode': '0600',
      'secrets-encryption': true,
      disable: ['traefik', 'servicelb'],
      'cluster-cidr': '10.42.0.0/16',
      'service-cidr': '10.43.0.0/16',
    },
    'namespace.json': { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } },
    'media-storage-class.json': {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: 'temporal-media-local' },
      provisioner: 'rancher.io/local-path',
      parameters: { nodePath: '/var/lib/urm-temporal/media' },
      reclaimPolicy: 'Delete',
      volumeBindingMode: 'WaitForFirstConsumer',
    },
    'local-path-config-patch.json': {
      data: {
        'config.json': JSON.stringify({
          nodePathMap: [{ node: 'DEFAULT_PATH_FOR_NON_LISTED_NODES', paths: ['/var/lib/urm-temporal/media'] }],
        }),
      },
    },
    'identity.env': `FIREBASE_PROJECT_ID=${projectId}\nTEMPORAL_KUBERNETES_NAMESPACE=${namespace}\nGCE_INSTANCE_ID=${instanceId}\n`,
    'k3s.service': `[Unit]\nDescription=Single-node application worker supervisor\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=notify\nUser=root\nDelegate=yes\nKillMode=process\nLimitNOFILE=1048576\nLimitNPROC=infinity\nTasksMax=infinity\nRestart=always\nRestartSec=5\nExecStart=/usr/local/bin/k3s server --config /etc/rancher/k3s/config.yaml\n\n[Install]\nWantedBy=multi-user.target\n`,
    'temporal-storage-setup.service': `[Unit]\nDescription=Keep single-host scratch provisioning on its dedicated mount\nAfter=k3s.service\nRequires=k3s.service\nPartOf=k3s.service\nStartLimitIntervalSec=0\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nUser=root\nExecStart=/usr/local/bin/k3s kubectl --server=https://${privateIp}:6443 -n kube-system patch configmap local-path-config --type=merge --patch-file=/etc/urm-temporal/local-path-config-patch.json\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n`,
    'wait-node.sh': `#!/bin/sh
set -eu
task_attempt=0
until /usr/local/bin/k3s kubectl --server=https://${privateIp}:6443 get node/${instanceName} >/dev/null 2>&1; do
  task_attempt=$((task_attempt + 1))
  if [ "$task_attempt" -ge 90 ]; then
    echo 'Actual single Node did not register within90seconds' >&2
    exit 1
  fi
  sleep 1
done
/usr/local/bin/k3s kubectl --server=https://${privateIp}:6443 wait --for=condition=Ready node/${instanceName} --timeout=180s
`,
    'bootstrap.sh': `#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root on the reviewed VM' >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo 'Reviewed binary requires amd64' >&2; exit 1; }
task_dir=$(dirname "$(readlink -f "$0")")
task_metadata=http://169.254.169.254/computeMetadata/v1
[ "$(curl -fsS -H 'Metadata-Flavor: Google' "$task_metadata/project/project-id")" = '${projectId}' ]
[ "$(curl -fsS -H 'Metadata-Flavor: Google' "$task_metadata/instance/id")" = '${instanceId}' ]
[ "$(curl -fsS -H 'Metadata-Flavor: Google' "$task_metadata/instance/service-accounts/default/email")" = 'temporal-worker@${projectId}.iam.gserviceaccount.com' ]
mountpoint -q /var/lib/urm-temporal/media || { echo 'Dedicated media disk must be mounted first' >&2; exit 1; }
task_capacity=$(df -B1 --output=size /var/lib/urm-temporal/media | tail -n 1 | tr -d ' ')
[ "$task_capacity" -ge 429496729600 ] || { echo 'Actual media filesystem is smaller than400Gi' >&2; exit 1; }
task_tmp=$(mktemp -d)
trap 'rm -r "$task_tmp"' EXIT HUP INT TERM
task_url='https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(versions.k3s)}'
curl --proto '=https' --tlsv1.2 -fsSL "$task_url/k3s" -o "$task_tmp/k3s"
curl --proto '=https' --tlsv1.2 -fsSL "$task_url/sha256sum-amd64.txt" -o "$task_tmp/checksums"
awk '$2 == "k3s" || $2 == "*k3s" {print}' "$task_tmp/checksums" > "$task_tmp/k3s.sha256"
[ -s "$task_tmp/k3s.sha256" ] || { echo 'Pinned release lacks its exact binary checksum' >&2; exit 1; }
(cd "$task_tmp" && sha256sum --check k3s.sha256)
if [ -e /usr/local/bin/k3s ]; then
  cmp -s "$task_tmp/k3s" /usr/local/bin/k3s || { echo 'Existing K3s binary differs; require an explicit reviewed drain/upgrade before replacing it' >&2; exit 1; }
else
  install -m0755 "$task_tmp/k3s" /usr/local/bin/k3s
fi
install -d -m0700 /etc/rancher/k3s /etc/urm-temporal
if [ -e /etc/rancher/k3s/config.yaml ]; then
  cmp -s "$task_dir/k3s-config.json" /etc/rancher/k3s/config.yaml || { echo 'Existing K3s configuration differs; review the change before rerunning bootstrap' >&2; exit 1; }
else
  install -m0600 "$task_dir/k3s-config.json" /etc/rancher/k3s/config.yaml
fi
install -m0600 "$task_dir/identity.env" /etc/urm-temporal/identity.env
install -m0600 "$task_dir/local-path-config-patch.json" /etc/urm-temporal/local-path-config-patch.json
install -m0644 "$task_dir/k3s.service" /etc/systemd/system/k3s.service
install -m0644 "$task_dir/temporal-storage-setup.service" /etc/systemd/system/temporal-storage-setup.service
systemctl daemon-reload
systemctl enable --now k3s.service
sh "$task_dir/wait-node.sh"
/usr/local/bin/k3s kubectl --server=https://${privateIp}:6443 apply -f "$task_dir/namespace.json"
/usr/local/bin/k3s kubectl --server=https://${privateIp}:6443 apply -f "$task_dir/media-storage-class.json"
systemctl enable --now temporal-storage-setup.service
/usr/local/bin/k3s secrets-encrypt status
echo 'Single-node supervisor ready. Record actual cluster/Node/filesystem evidence before deploying workers.'
`,
    'INSTALL.md': `# Reviewed single-node bootstrap\n\nActual target: ${projectId} / ${instanceName} / instance ${instanceId}, private ${privateIp}. Verify this identity on the VM metadata service before installation. This output creates no remote resources and requires no VIP, extra nodes, etcd cluster or database.\n\n1. Mount the dedicated media disk at /var/lib/urm-temporal/media; preserve an existing filesystem and confirm its actual capacity covers 400Gi.\n2. Download the official k3s ${
      versions.k3s
    } amd64 binary and sha256sum-amd64.txt from https://github.com/k3s-io/k3s/releases/tag/${encodeURIComponent(
      versions.k3s
    )}. Verify the k3s checksum before placing it at /usr/local/bin/k3s mode0755.\n3. Install k3s-config.json as /etc/rancher/k3s/config.yaml mode0600 (JSON is valid YAML), and k3s.service as /etc/systemd/system/k3s.service. Enable/start that unit; wait for the actual single Node to be Ready.\n4. Apply namespace.json and media-storage-class.json with k3s kubectl. Merge-patch kube-system ConfigMap local-path-config with local-path-config-patch.json.\n5. Install identity.env as /etc/urm-temporal/identity.env mode0600. Install Node22, the reviewed temporal-vm-secrets.mjs script and temporal-key-sync service/timer from ops/temporal/single-vm. Enable/start the timer only after scoped Secret Manager permissions and keys are ready.\n6. Record the actual kube-system UID, Node name/UID, private Kubernetes service443/API6443 addresses and dedicated filesystem report in the platform descriptor. Render/deploy immutable application workers only after those live facts validate.\n\nKeep all public API/NodePort ingress closed. Use authenticated IAP SSH forwarding for administration.\n`,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    flags = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  if (!flags['--output']) throw new Error('--output directory is required');
  const files = renderSingleVmBootstrap({
    projectId: flags['--project'],
    instanceName: flags['--instance-name'],
    instanceId: flags['--instance-id'],
    privateIp: flags['--private-ip'],
  });
  await mkdir(flags['--output'], { recursive: true });
  for (const [name, value] of Object.entries(files))
    await writeFile(
      resolve(flags['--output'], name),
      typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
      { mode: 0o600 }
    );
  console.log('Rendered reviewed single-node bootstrap files; no remote resources changed.');
}
