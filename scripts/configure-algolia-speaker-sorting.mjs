import { algoliasearch } from 'algoliasearch';

const appId = process.env.ALGOLIA_APP_ID?.trim();
const adminApiKey = process.env.ALGOLIA_ADMIN_API_KEY?.trim();
const primaryIndexName = process.env.ALGOLIA_SPEAKER_INDEX_NAME?.trim() || 'speakers';

const speakerReplicaIndices = {
  sermonCount: {
    asc: 'speakers_sort_sermonCount_asc',
    desc: 'speakers_sort_sermonCount_desc',
  },
  name: {
    asc: 'speakers_sort_name_asc',
    desc: 'speakers_sort_name_desc',
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

const waitForIndexTask = async (client, indexName, taskID) => {
  await client.waitForTask({ indexName, taskID });
};

if (!appId || !adminApiKey) {
  console.error(
    'Missing Algolia credentials. Set ALGOLIA_APP_ID and ALGOLIA_ADMIN_API_KEY before running this script.'
  );
  process.exit(1);
}

const client = algoliasearch(appId, adminApiKey);

const allReplicaIndexNames = [
  speakerReplicaIndices.sermonCount.asc,
  speakerReplicaIndices.sermonCount.desc,
  speakerReplicaIndices.name.asc,
  speakerReplicaIndices.name.desc,
];

const primaryResponse = await client.setSettings({
  indexName: primaryIndexName,
  indexSettings: {
    replicas: allReplicaIndexNames,
  },
});

await waitForIndexTask(client, primaryIndexName, primaryResponse.taskID);

const replicaSettings = [
  {
    indexName: speakerReplicaIndices.sermonCount.desc,
    indexSettings: {
      ranking: exhaustiveRanking('desc(sermonCount)'),
    },
  },
  {
    indexName: speakerReplicaIndices.sermonCount.asc,
    indexSettings: {
      ranking: exhaustiveRanking('asc(sermonCount)'),
    },
  },
  {
    indexName: speakerReplicaIndices.name.asc,
    indexSettings: {
      customRanking: ['asc(name)'],
    },
  },
  {
    indexName: speakerReplicaIndices.name.desc,
    indexSettings: {
      customRanking: ['desc(name)'],
    },
  },
];

for (const settingsUpdate of replicaSettings) {
  const response = await client.setSettings(settingsUpdate);
  await waitForIndexTask(client, settingsUpdate.indexName, response.taskID);
}

console.log(`Configured speaker sorting replicas for "${primaryIndexName}".`);
