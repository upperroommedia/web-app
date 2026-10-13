#!/usr/bin/env node
// Generates reviewed host install inputs; does not SSH, purchase hosts, or mutate this computer.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { versions } from './temporal-platform.mjs';
const args = process.argv.slice(2);
const flags = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
if (!flags['--inventory'] || !flags['--peer-inventory'] || !flags['--output'])
  throw new Error('Usage: temporal-k3s-config.mjs --inventory PATH --peer-inventory PATH --output DIR');
const input = JSON.parse(await readFile(flags['--inventory'], 'utf8'));
const peer = JSON.parse(await readFile(flags['--peer-inventory'], 'utf8'));
const privateIp = (ip) =>
  typeof ip === 'string' &&
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) &&
  ip.split('.').length === 4 &&
  ip.split('.').every((n) => /^\d+$/.test(n) && +n < 256);
if (
  !['staging', 'production'].includes(input.environment) ||
  input.environment === peer.environment ||
  !privateIp(input.privateApiVip) ||
  input.privateApiVip === peer.privateApiVip ||
  !/^[a-z][a-z0-9-]{0,14}$/.test(input.privateInterface ?? '') ||
  !Array.isArray(input.nodes) ||
  input.nodes.length < 3 ||
  input.nodes.length % 2 !== 1
)
  throw new Error('Distinct environments, a private HA API VIP, interface and odd >=3 server inventory are required');
for (const key of ['podCidr', 'serviceCidr'])
  if (!/^10\.\d+\.0\.0\/16$/.test(input[key] ?? '')) throw new Error(`${key} must be an explicit private/16 CIDR`);
if (input.podCidr === input.serviceCidr) throw new Error('Pod and service networks must differ');
const addresses = new Set();
for (const node of input.nodes) {
  if (
    !/^[a-z0-9-]{1,63}$/.test(node.name) ||
    !privateIp(node.privateIp) ||
    addresses.has(node.privateIp) ||
    peer.nodes?.some((n) => n.privateIp === node.privateIp)
  )
    throw new Error('All nodes must be unique private hosts and must not belong to the other environment');
  addresses.add(node.privateIp);
}
await mkdir(flags['--output'], { recursive: true, mode: 0o700 });
for (const [index, node] of input.nodes.entries()) {
  const config = {
    ...(index === 0 ? { 'cluster-init': true } : { server: `https://${input.privateApiVip}:6443` }),
    'token-file': '/etc/rancher/k3s/cluster-token',
    'node-name': node.name,
    'node-ip': node.privateIp,
    'advertise-address': node.privateIp,
    'bind-address': node.privateIp,
    'tls-san': [input.privateApiVip],
    'tls-san-security': true,
    'write-kubeconfig-mode': '0600',
    'flannel-iface': input.privateInterface,
    'flannel-backend': 'wireguard-native',
    'cluster-cidr': input.podCidr,
    'service-cidr': input.serviceCidr,
    disable: ['traefik', 'servicelb'],
    'secrets-encryption': true,
    'etcd-snapshot-schedule-cron': '0 */6 * * *',
    'etcd-snapshot-retention': 14,
    'etcd-s3': true,
    'etcd-s3-config-secret': 'temporal-etcd-backups',
    'kube-apiserver-arg': ['anonymous-auth=false'],
    'protect-kernel-defaults': true,
  };
  await writeFile(resolve(flags['--output'], `${node.name}.config.json`), JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
}
const install = `#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run only on the reviewed dedicated host as root' >&2; exit 1; }
[ -s /etc/rancher/k3s/config.yaml ] && [ -s /etc/rancher/k3s/cluster-token ] || { echo 'Install reviewed config and protected token before bootstrap' >&2; exit 1; }
case "$(uname -m)" in x86_64) artifact=k3s; sums=sha256sum-amd64.txt;; aarch64) artifact=k3s-arm64; sums=sha256sum-arm64.txt;; *) exit 1;; esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
base='https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(versions.k3s)}'
curl --fail --show-error --silent --location "$base/$artifact" -o "$artifact"
curl --fail --show-error --silent --location "$base/$sums" -o "$sums"
awk -v target="$artifact" '$2 == target {print}' "$sums" > selected.sha256
[ -s selected.sha256 ] || { echo 'Pinned release checksum not found' >&2; exit 1; }
sha256sum -c selected.sha256
install -m 0755 "$artifact" /usr/local/bin/k3s
install -d -m 0700 /var/lib/rancher/k3s
cat > /etc/systemd/system/k3s.service <<'UNIT'
[Unit]
Description=Upper Room private HA Kubernetes
Wants=network-online.target
After=network-online.target
[Service]
Type=notify
ExecStart=/usr/local/bin/k3s server
Restart=always
RestartSec=5
KillMode=process
Delegate=yes
LimitNOFILE=1048576
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
TimeoutStartSec=0
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now k3s
`;
await writeFile(resolve(flags['--output'], 'install-reviewed-host.sh'), install, { mode: 0o700 });
console.log(
  `Rendered${input.nodes.length} private HA control-plane configs and a pinned host bootstrap script. No hosts modified.`
);
