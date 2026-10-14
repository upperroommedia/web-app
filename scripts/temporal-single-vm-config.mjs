#!/usr/bin/env node
// Offline single-node bootstrap output; no cloud or host mutations.
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { versions, GCE_FIREBASE_ADC_SCOPES } from './temporal-platform.mjs';
const helper = readFileSync(new URL('../ops/temporal/single-vm/media-storage.py', import.meta.url), 'utf8');
const target = '/var/lib/urm-temporal/media';
const operator = '/usr/local/libexec/urm-temporal-media-storage';
const configPath = '/etc/urm-temporal/media-storage.json';
const record = '/etc/urm-temporal/media-storage-enrollment.json';
const permit = '/etc/urm-temporal/media-storage.initializing';
const skip = '/var/lib/rancher/k3s/server/manifests/local-storage.yaml.skip';
export function renderSingleVmBootstrap({ projectId, instanceName, instanceId, privateIp, mediaFilesystemUuid }) {
  const environment = { 'urm-app-staging': 'staging', 'urm-app': 'production' }[projectId];
  if (
    !environment ||
    instanceName !== `urm-temporal-${environment}` ||
    typeof instanceId !== 'string' ||
    !/^\d+$/.test(instanceId) ||
    instanceId.trim() !== instanceId ||
    isIP(privateIp) !== 4 ||
    !/^10\./.test(privateIp) ||
    /^10\.(42|43)\./.test(privateIp) ||
    typeof mediaFilesystemUuid !== 'string' ||
    mediaFilesystemUuid.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(mediaFilesystemUuid ?? '')
  )
    throw new Error(
      'Exact reviewed project/instance, private IPv4 and actual canonical media filesystem UUID required'
    );
  const namespace = `temporal-${environment}`;
  const mediaConfig = { schemaVersion: 1, projectId, instanceName, instanceId, privateIp, mediaFilesystemUuid };
  const configHash = createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(Object.entries(mediaConfig).sort(([a], [b]) => a.localeCompare(b)))))
    .digest('hex');
  const guard = `${operator} guard --config ${configPath}`;
  return {
    'media-storage.py': helper,
    'media-storage.json': mediaConfig,
    'media-storage-initial-permit.json': { schemaVersion: 1, configSha256: configHash },
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
      parameters: { nodePath: target },
      reclaimPolicy: 'Delete',
      volumeBindingMode: 'WaitForFirstConsumer',
    },
    'identity.env': `FIREBASE_PROJECT_ID=${projectId}
TEMPORAL_KUBERNETES_NAMESPACE=${namespace}
GCE_INSTANCE_ID=${instanceId}
`,
    'k3s.service': `[Unit]
Description=Single-node application worker supervisor
After=network-online.target
Wants=network-online.target
RequiresMountsFor=${target}

[Service]
Type=notify
User=root
Delegate=yes
KillMode=process
LimitNOFILE=1048576
LimitNPROC=infinity
TasksMax=infinity
Restart=always
RestartSec=5
ExecStartPre=${guard}
ExecStart=/usr/local/bin/k3s server --config /etc/rancher/k3s/config.yaml

[Install]
WantedBy=multi-user.target
`,
    'temporal-storage-setup.service': `[Unit]
Description=Reconcile enrolled local-path configuration on its dedicated mount
After=k3s.service
Requires=k3s.service
PartOf=k3s.service
RequiresMountsFor=${target}
StartLimitIntervalSec=0

[Service]
Type=oneshot
RemainAfterExit=yes
User=root
ExecStartPre=${guard}
ExecStart=${operator} reconcile --config ${configPath}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=k3s.service
`,
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
    'classify-installation.sh': `#!/bin/sh
set -eu
fail() { echo 'Existing K3s state requires explicit audited maintenance; fresh enrollment is forbidden' >&2; exit 1; }
task_load_state=$(systemctl show k3s.service --property=LoadState --value) || fail
task_fragment=$(systemctl show k3s.service --property=FragmentPath --value) || fail
task_drop_ins=$(systemctl show k3s.service --property=DropInPaths --value) || fail
[ -z "$task_drop_ins" ] || fail
# Unsupported drop-ins can override ExecStartPre or ExecStart after installing the base unit.
for task_path in /etc/systemd/system/k3s.service.d /run/systemd/system/k3s.service.d /usr/lib/systemd/system/k3s.service.d /lib/systemd/system/k3s.service.d; do
  [ ! -e "$task_path" ] && [ ! -L "$task_path" ] || fail
done
if [ -e '${record}' ] || [ -L '${record}' ]; then
  [ -f '${record}' ] && [ ! -L '${record}' ] || fail
  [ "$task_load_state" = loaded ] && [ "$task_fragment" = /etc/systemd/system/k3s.service ] || fail
  [ -f /etc/systemd/system/k3s.service ] && [ ! -L /etc/systemd/system/k3s.service ] || fail
  echo enrolled
  exit 0
fi
[ "$task_load_state" = not-found ] && [ -z "$task_fragment" ] || fail
# An absent/moved unit file does not erase a cluster. Never mint a permit for retained state.
for task_path in /etc/systemd/system/k3s.service /usr/lib/systemd/system/k3s.service /lib/systemd/system/k3s.service /run/systemd/system/k3s.service /var/lib/rancher/k3s /etc/rancher/k3s /etc/rancher/node /run/k3s '${permit}' '${skip}'; do
  [ ! -e "$task_path" ] && [ ! -L "$task_path" ] || fail
done
echo fresh
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
task_scopes=$(curl -fsS -H 'Metadata-Flavor: Google' "$task_metadata/instance/service-accounts/default/scopes" | sort)
[ "$task_scopes" = '${[...GCE_FIREBASE_ADC_SCOPES]
      .sort()
      .join('\n')}' ] || { echo 'Exact three reviewed ADC scopes required' >&2; exit 1; }
if systemctl is-active --quiet k3s.service; then
  echo 'Existing active K3s requires explicit reviewed maintenance; bootstrap never restarts it' >&2
  exit 1
fi
task_installation=$(sh "$task_dir/classify-installation.sh")
case "$task_installation" in
  fresh) task_initial=true ;;
  enrolled) task_initial=false ;;
  *) echo 'Installation authority unknown; never recreate it on startup' >&2; exit 1 ;;
esac
install_same() {
  if [ -e "$2" ] || [ -L "$2" ]; then
    [ -f "$2" ] && [ ! -L "$2" ] && [ "$(stat -c %u "$2")" = 0 ] && [ "0$(stat -c %a "$2")" = "$3" ] || { echo "Existing $2 is not an exact protected regular file; require explicit reviewed maintenance" >&2; exit 1; }
    cmp -s "$1" "$2" || { echo "Existing $2 differs; require explicit reviewed maintenance" >&2; exit 1; }
  else
    install -m"$3" "$1" "$2"
  fi
}
install -d -m0700 /etc/rancher/k3s /etc/urm-temporal
install -d -m0755 /usr/local/libexec
install_same "$task_dir/media-storage.json" '${configPath}' 0600
install_same "$task_dir/media-storage.py" '${operator}' 0755
python3 '${operator}' mount-check --config '${configPath}'
task_capacity=$(df -B1 --output=size '${target}' | tail -n 1 | tr -d ' ')
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
install_same "$task_dir/k3s-config.json" /etc/rancher/k3s/config.yaml 0600
install_same "$task_dir/identity.env" /etc/urm-temporal/identity.env 0600
install_same "$task_dir/k3s.service" /etc/systemd/system/k3s.service 0644
install_same "$task_dir/temporal-storage-setup.service" /etc/systemd/system/temporal-storage-setup.service 0644
if [ "$task_initial" = true ]; then
  [ ! -e '${permit}' ] || { echo 'Initial permit already exists; inspect interrupted bootstrap' >&2; exit 1; }
  install -m0600 "$task_dir/media-storage-initial-permit.json" '${permit}'
fi
systemctl daemon-reload
systemctl enable k3s.service
systemctl start k3s.service
sh "$task_dir/wait-node.sh"
task_attempt=0
until /usr/local/bin/k3s kubectl --server=https://${privateIp}:6443 -n kube-system get configmap local-path-config >/dev/null 2>&1; do
  task_attempt=$((task_attempt + 1))
  [ "$task_attempt" -lt 90 ] || { echo 'Packaged local-path resources missing' >&2; exit 1; }
  sleep 1
done
# First packaged resources must exist before suppressing future manifest rewrites.
[ -f /var/lib/rancher/k3s/server/manifests/local-storage.yaml ] || { echo 'Packaged local-storage manifest missing' >&2; exit 1; }
if [ "$task_initial" = true ]; then
  [ ! -e '${skip}' ] && [ ! -L '${skip}' ] || { echo 'Unexpected preexisting packaged skip; require explicit maintenance' >&2; exit 1; }
  install -m0600 /dev/null '${skip}'
  python3 '${operator}' enroll --config '${configPath}'
  rm '${permit}'
fi
/usr/local/bin/k3s kubectl --server=https://${privateIp}:6443 apply -f "$task_dir/namespace.json"
/usr/local/bin/k3s kubectl --server=https://${privateIp}:6443 apply -f "$task_dir/media-storage-class.json"
systemctl enable --now temporal-storage-setup.service
python3 '${operator}' check --config '${configPath}'
/usr/local/bin/k3s secrets-encrypt status
echo 'Single-node supervisor ready. Record actual cluster/Node/filesystem evidence before deploying workers.'
`,
    'INSTALL.md': `# Reviewed single-node bootstrap

Actual target: ${projectId} / ${instanceName} / instance ${instanceId}, private ${privateIp}.
Verify the actual dedicated ext4 filesystem UUID ${mediaFilesystemUuid} and exact device /dev/disk/by-id/google-${instanceName}-media, mounted at ${target}, separately from root. Preserve its filesystem; this output never formats or mounts disks.

Run bootstrap.sh as root only for the reviewed inactive/fresh host. Fresh enrollment additionally requires systemd to report no effective K3s unit and no retained server/datastore/manifests, kubeconfig, node password, runtime state or prior initialization permit. A moved unit or vendor unit is existing state, never permission to create a fresh enrollment. It verifies metadata identity and all three reviewed ADC scopes, preserves the pinned binary and original K3s command, and refuses implicit maintenance of an active service or replacement of existing configuration. First start uses a protected config-bound initialization permit. After Node and packaged local-path ConfigMap exist, bootstrap installs local-storage.yaml.skip, explicitly enrolls the actual ConfigMap UID and non-config data hash once, removes the permit, and starts/checks the reconciler. Missing enrollment on an existing installation requires explicit audited repair; startup never recreates it.

Keep the enrollment file and .skip persistent. K3s itself requires the mount and guard before startup; the operator repeats the guard and performs UID/resourceVersion/full-data CAS on config.json only. ConfigMap recreation or other data changes stop reconciliation. No RBAC, PVC or competing AddOn is introduced. Install the reviewed key-sync services separately after scoped permissions/credentials are ready. Record actual Kubernetes and filesystem evidence before deploying workers. Keep public API/NodePort ingress closed and use authenticated IAP SSH administration.
`,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const allowed = [
    '--project',
    '--instance-name',
    '--instance-id',
    '--private-ip',
    '--media-filesystem-uuid',
    '--output',
  ];
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || Object.hasOwn(flags, args[i]))
      throw new Error('Exact nonduplicate bootstrap options required');
    flags[args[i]] = args[i + 1];
  }
  if (!flags['--output']) throw new Error('--output directory is required');
  const files = renderSingleVmBootstrap({
    projectId: flags['--project'],
    instanceName: flags['--instance-name'],
    instanceId: flags['--instance-id'],
    privateIp: flags['--private-ip'],
    mediaFilesystemUuid: flags['--media-filesystem-uuid'],
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
