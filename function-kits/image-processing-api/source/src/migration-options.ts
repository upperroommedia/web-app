import { GlobalOptions, MemoryOption, VpcEgressSetting, IngressSetting } from 'firebase-functions/v2/options';

// Match Firebase's index-kit-migration template. Never forward protobuf
// UNSPECIFIED sentinels to SDK enums, and preserve numeric zero explicitly.
export function migratedGlobalOptions(env: NodeJS.ProcessEnv): GlobalOptions {
  const options: GlobalOptions = { memory: '1GiB', concurrency: 4, maxInstances: 20, timeoutSeconds: 60 };
  const numeric = (name: string): number | undefined => {
    if (!env[name]) return undefined;
    const value = Number(env[name]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
    return value;
  };
  const memory = env.EXT_MIGRATED_SYSTEM_MEMORY;
  if (memory) {
    if (!['128MiB', '256MiB', '512MiB', '1GiB', '2GiB', '4GiB', '8GiB', '16GiB', '32GiB'].includes(memory)) throw new Error('EXT_MIGRATED_SYSTEM_MEMORY is invalid.');
    options.memory = memory as MemoryOption;
  }
  for (const [envName, optionName] of [
    ['TIMEOUTSECONDS', 'timeoutSeconds'], ['MAXINSTANCES', 'maxInstances'],
    ['MININSTANCES', 'minInstances'], ['CONCURRENCY', 'concurrency'], ['CPU', 'cpu'],
  ] as const) {
    const value = numeric(`EXT_MIGRATED_SYSTEM_${envName}`);
    if (value !== undefined) options[optionName] = value;
  }
  const egress = env.EXT_MIGRATED_SYSTEM_VPCCONNECTOREGRESSSETTINGS;
  if (egress && egress !== 'VPC_CONNECTOR_EGRESS_SETTINGS_UNSPECIFIED') {
    if (!['PRIVATE_RANGES_ONLY', 'ALL_TRAFFIC'].includes(egress)) throw new Error('EXT_MIGRATED_SYSTEM_VPCCONNECTOREGRESSSETTINGS is invalid.');
    options.vpcConnectorEgressSettings = egress as VpcEgressSetting;
  }
  if (env.EXT_MIGRATED_SYSTEM_VPCCONNECTOR) options.vpcConnector = env.EXT_MIGRATED_SYSTEM_VPCCONNECTOR;
  const ingress = env.EXT_MIGRATED_SYSTEM_INGRESSSETTINGS;
  if (ingress && ingress !== 'INGRESS_SETTINGS_UNSPECIFIED') {
    if (!['ALLOW_ALL', 'ALLOW_INTERNAL_ONLY', 'ALLOW_INTERNAL_AND_GCLB'].includes(ingress)) throw new Error('EXT_MIGRATED_SYSTEM_INGRESSSETTINGS is invalid.');
    options.ingressSettings = ingress as IngressSetting;
  }
  if (env.EXT_MIGRATED_SYSTEM_LABELS) {
    const labels: Record<string, string> = {};
    for (const pair of env.EXT_MIGRATED_SYSTEM_LABELS.split(',')) {
      const colon = pair.indexOf(':');
      if (colon < 0) continue;
      const key = pair.slice(0, colon).trim(), value = pair.slice(colon + 1).trim();
      if (key && value) labels[key] = value;
    }
    if (Object.keys(labels).length) options.labels = labels;
  }
  if (env.EXT_MIGRATED_SYSTEM_SERVICEACCOUNTEMAIL) options.serviceAccount = env.EXT_MIGRATED_SYSTEM_SERVICEACCOUNTEMAIL;
  return options;
}
