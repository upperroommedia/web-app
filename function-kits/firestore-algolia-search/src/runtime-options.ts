import type {GlobalOptions, IngressSetting, MemoryOption, VpcEgressSetting} from 'firebase-functions/v2/options';

type Environment = Record<string, string | undefined>;
const memoryOptions: MemoryOption[] = ['128MiB', '256MiB', '512MiB', '1GiB', '2GiB', '4GiB', '8GiB', '16GiB', '32GiB'];

/** Translate CLI-exported extension system settings without declaring duplicate global
 * defaults in the CLI-generated instance wrapper. Exported values take precedence. */
export function migratedRuntimeOptions(env: Environment): GlobalOptions {
  const options: GlobalOptions = {memory: '512MiB', minInstances: 0};
  const setting = (...names: string[]) => names.map(name => env[`EXT_MIGRATED_SYSTEM_${name}`]?.trim()).find(Boolean);
  const numeric = (name: string, value: string, integer = true): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) throw new Error(`Invalid migrated ${name}: ${value}`);
    return parsed;
  };
  if (env.FUNCTION_DEFAULT_REGION?.trim()) options.region = env.FUNCTION_DEFAULT_REGION.trim();
  const memory = setting('MEMORY');
  if (memory) {
    const match = /^(\d+)\s*(MB|MiB|GB|GiB)?$/i.exec(memory);
    const mb = match ? Number(match[1]) * (/^G/i.test(match[2] ?? '') ? 1024 : 1) : NaN;
    const normalized = mb >= 1024 ? `${mb / 1024}GiB` : `${mb}MiB`;
    if (!memoryOptions.includes(normalized as MemoryOption)) throw new Error(`Invalid migrated memory: ${memory}`);
    options.memory = normalized as MemoryOption;
  }
  for (const [suffix, field] of [['MININSTANCES', 'minInstances'], ['MAXINSTANCES', 'maxInstances'], ['CONCURRENCY', 'concurrency']] as const) {
    const value = setting(suffix);
    if (value) options[field] = numeric(suffix, value);
  }
  const timeout = setting('TIMEOUTSECONDS', 'TIMEOUT');
  if (timeout) options.timeoutSeconds = numeric('timeout', timeout.replace(/s$/, ''));
  const cpu = setting('CPU');
  if (cpu) {
    options.cpu = cpu === 'gcf_gen1' ? cpu : numeric('CPU', cpu, false);
    if (options.cpu === 0) throw new Error('Migrated CPU must be positive');
  }
  const vpc = setting('VPCCONNECTOR');
  if (vpc) options.vpcConnector = vpc;
  const egress = setting('VPCCONNECTOREGRESSSETTINGS', 'VPCEGRESS');
  if (egress && egress !== 'VPC_CONNECTOR_EGRESS_SETTINGS_UNSPECIFIED') {
    if (!['PRIVATE_RANGES_ONLY', 'ALL_TRAFFIC'].includes(egress)) throw new Error(`Invalid migrated VPC egress: ${egress}`);
    options.vpcConnectorEgressSettings = egress as VpcEgressSetting;
  }
  const ingress = setting('INGRESSSETTINGS');
  if (ingress && ingress !== 'INGRESS_SETTINGS_UNSPECIFIED') {
    if (!['ALLOW_ALL', 'ALLOW_INTERNAL_ONLY', 'ALLOW_INTERNAL_AND_GCLB'].includes(ingress)) throw new Error(`Invalid migrated ingress: ${ingress}`);
    options.ingressSettings = ingress as IngressSetting;
  }
  const serviceAccount = setting('SERVICEACCOUNTEMAIL', 'SERVICEACCOUNT');
  if (serviceAccount) options.serviceAccount = serviceAccount;
  const labels = setting('LABELS');
  if (labels) {
    const parsed: unknown = JSON.parse(labels);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error('Migrated labels must be a JSON object of strings');
    options.labels = parsed as Record<string, string>;
  }
  return options;
}
