import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import target from '../../../../packages/contracts/staging-search.json';
import { loadSearchConfigurations, validateSearchConfigurations } from './search-config';
const valid = () =>
  Object.fromEntries(
    target.instances
      .map((instance) => [
        instance.instanceId,
        {
          ...instance,
          fields: instance.fields.join(','),
          projectId: target.projectId,
          appId: target.appId,
          location: target.location,
          writeKey: `private-${instance.instanceId}`,
        },
      ])
      .map(([id, config]) => {
        const value = config as Record<string, unknown>;
        delete value.instanceId;
        return [id, value];
      })
  );
test('validates exact staging private instance map and rejects production app, extra/missing instances, loose fields and transforms', () => {
  expect(Object.keys(validateSearchConfigurations(valid(), target.projectId))).toHaveLength(5);
  for (const patch of [
    { appId: '8OYPRODUCTION' },
    { projectId: 'urm-app' },
    { fields: '' },
    { transformFunction: 'anything' },
    { writeKey: '' },
    { recordPolicy: 'all-fields' },
    { indexName: 'other' },
    { collectionPath: 'other' },
  ]) {
    const configs = valid();
    Object.assign(configs['sermons-index'], patch);
    expect(() => validateSearchConfigurations(configs, target.projectId)).toThrow();
  }
  const missing = valid();
  delete missing['users-index'];
  expect(() => validateSearchConfigurations(missing, target.projectId)).toThrow();
  expect(() => validateSearchConfigurations({ ...valid(), unknown: {} }, target.projectId)).toThrow();
});
test('only search role requires private file and generic Algolia variables never substitute for it', () => {
  expect(loadSearchConfigurations(target.projectId, ['urm-images'], {})).toEqual({});
  expect(() =>
    loadSearchConfigurations(target.projectId, ['urm-search'], {
      ALGOLIA_APP_ID: target.appId,
      ALGOLIA_API_KEY: 'unused',
    })
  ).toThrow('TEMPORAL_SEARCH_CONFIG_FILE');
});

test('private template stays aligned with canonical field and instance policy and contains no usable keys', () => {
  const example = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../ops/temporal/staging-search-instances.example.json'), 'utf8')
  );
  expect(() => validateSearchConfigurations(example, target.projectId)).toThrow();
  for (const [id, config] of Object.entries(example)) (config as { writeKey: string }).writeKey = `private-${id}`;
  expect(() => validateSearchConfigurations(example, target.projectId)).not.toThrow();
});
