import { GlobalOptions } from 'firebase-functions/v2/options';

/** Preserve resource/network settings exported by firebase ext:export --for-functions. */
export function migratedOptions(env: NodeJS.ProcessEnv = process.env): GlobalOptions {
  const options: GlobalOptions = {};
  const names = {
    MEMORY: 'memory', CONCURRENCY: 'concurrency', MININSTANCES: 'minInstances', MAXINSTANCES: 'maxInstances',
    TIMEOUTSECONDS: 'timeoutSeconds', VPCCONNECTOR: 'vpcConnector',
    VPCCONNECTOREGRESSSETTINGS: 'vpcConnectorEgressSettings', INGRESSSETTINGS: 'ingressSettings',
    CPU: 'cpu', LABELS: 'labels', SERVICEACCOUNTEMAIL: 'serviceAccount', SERVICEACCOUNT: 'serviceAccount',
  } as const;
  for (const [key, option] of Object.entries(names)) {
    const value = env[`EXT_MIGRATED_SYSTEM_${key}`];
    if (!value || value.endsWith('_UNSPECIFIED')) continue;
    let parsed: any = value;
    if (['minInstances', 'maxInstances', 'timeoutSeconds', 'concurrency'].includes(option) || (option === 'cpu' && value !== 'gcf_gen1')) {
      parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || (option === 'concurrency' && (!Number.isInteger(parsed) || parsed < 1))) throw new Error(`Invalid migrated system setting ${key}`);
    } else if (option === 'labels') parsed = JSON.parse(value);
    (options as any)[option] = parsed;
  }
  if (options.cpu === 'gcf_gen1' || typeof options.cpu === 'number' && options.cpu < 1) options.concurrency = 1;
  if (env.FUNCTION_DEFAULT_REGION) options.region = env.FUNCTION_DEFAULT_REGION;
  return options;
}
