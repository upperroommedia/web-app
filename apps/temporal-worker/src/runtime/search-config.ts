import { readFileSync, statSync } from 'node:fs';
import target from '../../../../packages/contracts/staging-search.json';
import type { SearchConfig } from '../activities/search';

type PrivateSearchConfig = SearchConfig & { writeKey: string; recordPolicy?: string };

/** Never derive provider credentials or targets from generic ALGOLIA_* environment values. */
export function validateSearchConfigurations(value: unknown, projectId: string): Record<string, PrivateSearchConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid search instance map');
  const configurations = value as Record<string, PrivateSearchConfig>;
  for (const config of Object.values(configurations)) {
    if (
      !config ||
      config.projectId !== projectId ||
      typeof config.writeKey !== 'string' ||
      !config.writeKey.trim() ||
      /REQUIRED|PLACEHOLDER/.test(config.writeKey)
    )
      throw new Error('Invalid project-scoped search configuration');
  }
  if (projectId === target.projectId) {
    if (
      Object.keys(configurations).length !== target.instances.length ||
      Object.keys(configurations).some((id) => !target.instances.some((instance) => instance.instanceId === id))
    )
      throw new Error('Staging search requires the exact reviewed five-instance map');
    for (const instance of target.instances) {
      const config = configurations[instance.instanceId];
      if (
        !config ||
        config.appId !== target.appId ||
        config.collectionPath !== instance.collectionPath ||
        config.indexName !== instance.indexName ||
        config.location !== target.location ||
        config.fields !== instance.fields.join(',') ||
        config.altObjectId !== instance.altObjectId ||
        config.transformFunction !== instance.transformFunction ||
        config.recordPolicy !== instance.recordPolicy ||
        Object.keys(config).some(
          (key) =>
            ![
              'projectId',
              'appId',
              'indexName',
              'collectionPath',
              'location',
              'fields',
              'altObjectId',
              'transformFunction',
              'recordPolicy',
              'writeKey',
            ].includes(key)
        )
      )
        throw new Error('Staging search configuration differs from the reviewed target and record policy');
    }
  }
  return configurations;
}

export function loadSearchConfigurations(projectId: string, selectedQueues: readonly string[], env = process.env) {
  if (!selectedQueues.includes('urm-search')) return {};
  const path = env.TEMPORAL_SEARCH_CONFIG_FILE;
  if (!path) throw new Error('Search workers require TEMPORAL_SEARCH_CONFIG_FILE');
  // Kubernetes Secret volumes use0440; private local files may use0600.
  if ((statSync(path).mode & 0o007) !== 0)
    throw new Error('Search configuration must not be accessible to other users');
  return validateSearchConfigurations(JSON.parse(readFileSync(path, 'utf8')), projectId);
}
