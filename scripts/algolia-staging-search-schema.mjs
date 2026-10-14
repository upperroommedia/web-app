import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync(new URL('../packages/contracts/staging-search.json', import.meta.url), 'utf8'));
const freeze = value => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
};
export const STAGING_SEARCH_TARGET = freeze(schema);
export const STAGING_SEARCH_INSTANCES = STAGING_SEARCH_TARGET.instances;
export function validateStagingSearchTarget({ projectId, appId, indexNames }) {
  if (projectId !== STAGING_SEARCH_TARGET.projectId || appId !== STAGING_SEARCH_TARGET.appId) {
    throw new Error('Only the reviewed staging project and replacement Algolia application are allowed');
  }
  const expected = STAGING_SEARCH_INSTANCES.map(row => row.indexName).sort();
  if (!Array.isArray(indexNames) || JSON.stringify([...indexNames].sort()) !== JSON.stringify(expected)) {
    throw new Error('The exact five staging primary indexes are required');
  }
}
const ranking = ['typo', 'geo', 'words', 'filters', 'proximity', 'attribute', 'exact', 'custom'];
const replicas = {
  speakers: [
    ['speakers_sort_sermonCount_asc', { ranking: ['asc(sermonCount)', ...ranking] }],
    ['speakers_sort_sermonCount_desc', { ranking: ['desc(sermonCount)', ...ranking] }],
    ['speakers_sort_name_asc', { customRanking: ['asc(name)'] }],
    ['speakers_sort_name_desc', { customRanking: ['desc(name)'] }],
  ],
  lists: [
    ['lists_sort_name_asc', { customRanking: ['asc(name)'] }],
    ['lists_sort_name_desc', { customRanking: ['desc(name)'] }],
  ],
};
const search = {
  users: [], speakers: ['name', 'shortDescription'], sermons: ['title', 'subtitle', 'speakers.name', 'topics', 'seriesName'],
  images: ['name'], lists: ['name'],
};
const facets = {
  users: [], speakers: [], sermons: ['filterOnly(uploaderId)', 'status.subsplash', 'status.soundCloud', 'speakers.name'],
  images: ['filterOnly(type)'], lists: ['filterOnly(type)', 'filterOnly(isMoreSermonsList)'],
};
/** Complete deterministic primary and standard-replica settings; never inherit production. */
export function stagingSearchSettingsPlan(target) {
  validateStagingSearchTarget(target);
  const updates = [];
  for (const row of STAGING_SEARCH_INSTANCES) {
    const children = replicas[row.indexName] ?? [];
    const indexSettings = {
      searchableAttributes: search[row.indexName], attributesForFaceting: facets[row.indexName],
      attributesToRetrieve: row.recordPolicy === 'empty-private' ? ['objectID'] : ['objectID', ...new Set(row.fields.map(field => field.split('.')[0]))],
      attributesToHighlight: row.recordPolicy === 'empty-private' ? [] : [row.indexName === 'sermons' ? 'title' : 'name'],
      ranking, customRanking: [], replicas: children.map(([name]) => name),
    };
    updates.push({ indexName: row.indexName, indexSettings });
    for (const [indexName, sort] of children) updates.push({ indexName, indexSettings: { ...indexSettings, replicas: undefined, ...sort } });
  }
  return updates;
}
