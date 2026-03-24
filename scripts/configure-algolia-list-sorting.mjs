import { algoliasearch } from 'algoliasearch';

const appId = process.env.ALGOLIA_APP_ID?.trim();
const adminApiKey = process.env.ALGOLIA_ADMIN_API_KEY?.trim();
const primaryIndexName = process.env.ALGOLIA_LIST_INDEX_NAME?.trim() || 'lists';

const listReplicaIndices = {
  count: {
    asc: 'lists_sort_count_asc',
    desc: 'lists_sort_count_desc',
  },
  name: {
    asc: 'lists_sort_name_asc',
    desc: 'lists_sort_name_desc',
  },
};

const exhaustiveRanking = (rule) => [
  rule,
  'typo',
  'geo',
  'words',
  'filters',
  'proximity',
  'attribute',
  'exact',
  'custom',
];

if (!appId || !adminApiKey) {
  console.error(
    'Missing Algolia credentials. Set ALGOLIA_APP_ID and ALGOLIA_ADMIN_API_KEY before running this script.'
  );
  process.exit(1);
}

const client = algoliasearch(appId, adminApiKey);

const allReplicaIndexNames = [
  listReplicaIndices.count.asc,
  listReplicaIndices.count.desc,
  listReplicaIndices.name.asc,
  listReplicaIndices.name.desc,
];

const primaryResponse = await client.setSettings({
  indexName: primaryIndexName,
  indexSettings: {
    replicas: allReplicaIndexNames,
  },
});

await client.waitForTask({ indexName: primaryIndexName, taskID: primaryResponse.taskID });

const replicaSettings = [
  {
    indexName: listReplicaIndices.count.desc,
    indexSettings: {
      ranking: exhaustiveRanking('desc(count)'),
    },
  },
  {
    indexName: listReplicaIndices.count.asc,
    indexSettings: {
      ranking: exhaustiveRanking('asc(count)'),
    },
  },
  {
    indexName: listReplicaIndices.name.asc,
    indexSettings: {
      customRanking: ['asc(name)'],
    },
  },
  {
    indexName: listReplicaIndices.name.desc,
    indexSettings: {
      customRanking: ['desc(name)'],
    },
  },
];

for (const settingsUpdate of replicaSettings) {
  const response = await client.setSettings(settingsUpdate);
  await client.waitForTask({ indexName: settingsUpdate.indexName, taskID: response.taskID });
}

console.log(`Configured list sorting replicas for "${primaryIndexName}".`);
