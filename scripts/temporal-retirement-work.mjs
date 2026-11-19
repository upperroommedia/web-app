import { proofDigest } from './temporal-release-runtime.mjs';

const fail = () => {
  throw new Error('TRADITIONAL_RETIREMENT_WORK_UNCONFIRMED');
};

/** Exhaustive indexed counts avoid loading old job payloads. A terminal
 * dispatch with zero expiry can retain its old token and owner metadata.
 * Temporal separately proves that the original and candidate executions
 * have no pending Tasks. Activity head documents are historical fences. */
export async function readTraditionalRetirementWork(firestore, tx) {
  if (firestore.projectId !== 'urm-app-staging' || firestore.databaseId !== '(default)') fail();
  const count = async (query) => {
    const n = (await tx.get(query.count())).data().count;
    if (!Number.isSafeInteger(n) || n < 0) fail();
    return n;
  };
  const dispatch = async (collection) => {
    const docs = firestore.collection(collection);
    const [total, settled] = await Promise.all([
      count(docs),
      count(docs.where('state', '==', 'dispatched').where('leaseExpiresAt', '==', 0)),
    ]);
    return { total, settled };
  };
  const sessions = firestore.collection('temporalProviderMutationSessions');
  const [outbox, commands, providerSessions, settledSessions, critical, providerLocks, youtubeSlot] = await Promise.all(
    [
      dispatch('durableJobOutbox'),
      dispatch('durableJobCommands'),
      count(sessions),
      count(sessions.where('state', 'in', ['committed', 'aborted'])),
      count(firestore.collection('durableJobCriticalSections')),
      count(firestore.collection('temporalProviderMutationLocks')),
      tx.get(firestore.doc('temporalYouTubeRenderHosts/staging')),
    ]
  );
  if (
    typeof youtubeSlot.exists !== 'boolean' ||
    outbox.settled > outbox.total ||
    commands.settled > commands.total ||
    settledSessions > providerSessions
  )
    fail();
  return {
    outbox,
    commands,
    providerSessions,
    settledSessions,
    critical,
    providerLocks,
    youtubeSlot: youtubeSlot.exists,
  };
}

export function assertTraditionalRetirementWorkIdle(work) {
  if (
    work.outbox.total !== work.outbox.settled ||
    work.commands.total !== work.commands.settled ||
    work.providerSessions !== work.settledSessions ||
    work.critical !== 0 ||
    work.providerLocks !== 0 ||
    work.youtubeSlot !== false
  )
    fail();
  return proofDigest(work);
}

/** The paused release still has historical work from earlier builds. Find any
 * candidate work with bounded index lookups rather than paging that archive. */
export async function readReleaseCandidateWork(firestore, tx, buildId) {
  if (
    firestore.projectId !== 'urm-app-staging' ||
    firestore.databaseId !== '(default)' ||
    !/^[a-f0-9]{40}$/.test(buildId ?? '')
  )
    fail();
  const collections = [
    'durableJobOutbox',
    'durableJobCommands',
    'durableJobCriticalSections',
    'durableActivityExecutions',
    'temporalProviderMutationSessions',
    'temporalProviderMutationLocks',
  ];
  const entries = await Promise.all(
    collections.map(async (collection) => {
      const ref = firestore.collection(collection);
      const pages = await Promise.all(
        ['worker.buildId', 'execution.worker.buildId'].map((field) => tx.get(ref.where(field, '==', buildId).limit(2)))
      );
      const docs = new Map();
      for (const page of pages) {
        if (
          !Number.isSafeInteger(page.size) ||
          page.size < 0 ||
          page.size > 1 ||
          !Array.isArray(page.docs) ||
          page.docs.length !== page.size
        )
          fail();
        for (const doc of page.docs) {
          if (typeof doc.ref?.path !== 'string' || !doc.ref.path.startsWith(collection + '/')) fail();
          docs.set(doc.ref.path, doc);
        }
      }
      if (docs.size > 1) fail();
      return [...docs.values()].map((doc) => ({ collection, doc }));
    })
  );
  return entries.flat();
}
