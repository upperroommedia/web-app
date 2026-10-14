import { FieldValue } from 'firebase-admin/firestore';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { canonicalMirrorPatch, reconcileCurrentCanonicalMirrors } from '../currentCanonicalMirrors';
import { firestore } from 'firebase-functions/v2';
import { isEqual } from 'lodash';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { Sermon } from '@upperroom/shared/types/SermonTypes';
import handleError from '../../handleError';
import { algoliaSecretsWithRuntimeAlerts } from '../../algoliaSecrets';
import { waitForSermonToReachAlgolia } from '../../algoliaSyncSermon';

const firestoreAdmin = firebaseAdmin.firestore();

interface SearchSyncFields {
  searchPending?: boolean;
  searchIndexedAtMillis?: number;
  searchSyncError?: string;
  publishActivity?: unknown;
}

type SermonWithSearchSync = Sermon & SearchSyncFields;

const stripNonPropagatedFields = (sermon: SermonWithSearchSync) => {
  const {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    numberOfLists: _numberOfLists,
    numberOfListsUploadedTo: _numberOfListsUploadedTo,
    searchPending: _searchPending,
    searchIndexedAtMillis: _searchIndexedAtMillis,
    searchSyncError: _searchSyncError,
    publishActivity: _publishActivity,
    /* eslint-enable @typescript-eslint/no-unused-vars */
    ...rest
  } = sermon;

  return rest;
};

async function acknowledgeAlgoliaSync(sermonId: string) {
  const sermonRef = firestoreAdmin.doc(`sermons/${sermonId}`);
  const source = await sermonRef.get();
  const sermon = source.data() as SermonWithSearchSync | undefined;
  if (!sermon?.searchPending) return;
  const indexed = await waitForSermonToReachAlgolia({ sermonId, editedAtMillis: sermon.editedAtMillis });
  await firestoreAdmin.runTransaction(async (tx) => {
    const current = await tx.get(sermonRef);
    // Timestamp equality also fences same-millisecond edits and delete/recreate cycles.
    if (!sameSourceRevision(source, current) || !current.get('searchPending')) return;
    tx.update(
      sermonRef,
      indexed
        ? {
            searchPending: false,
            searchIndexedAtMillis: Date.now(),
            searchSyncError: FieldValue.delete(),
          }
        : { searchSyncError: 'Timed out waiting for Algolia to index the latest sermon version.' }
    );
  });
}

function sameSourceRevision(source: DocumentSnapshot, current: DocumentSnapshot): boolean {
  return (
    current.exists && Boolean(source.updateTime && current.updateTime && source.updateTime.isEqual(current.updateTime))
  );
}

const sermonWriteTrigger = firestore.onDocumentWritten(
  { document: 'sermons/{sermonId}', retry: true, secrets: algoliaSecretsWithRuntimeAlerts },
  async (event) => {
    const { sermonId } = event.params;

    const sermonBefore = event.data?.before.data() as SermonWithSearchSync | undefined;
    const sermonAfter = event.data?.after.data() as SermonWithSearchSync | undefined;
    let sermonBeforeNoCounts: Sermon | undefined = undefined;
    let sermonAfterNoCounts: Sermon | undefined = undefined;
    if (sermonBefore) {
      sermonBeforeNoCounts = stripNonPropagatedFields(sermonBefore);
    }
    if (sermonAfter) {
      sermonAfterNoCounts = stripNonPropagatedFields(sermonAfter);
    }
    try {
      // Canonical deletion and its frozen mirror inventory belong to the durable deletion operation.
      // Delayed delete events must never remove a recreated root or its descendants.
      if (!sermonAfter) return;
      if (sermonBefore && isEqual(sermonBeforeNoCounts, sermonAfterNoCounts)) return;
      await reconcileCurrentCanonicalMirrors(firestoreAdmin, {
        sourcePath: `sermons/${sermonId}`,
        collectionGroup: 'listItems',
        id: sermonId,
        parentCollection: 'lists',
        project: (canonical, mirror) => {
          const current = stripNonPropagatedFields(canonical as SermonWithSearchSync);
          // New list item documents embed the sermon; retain placement/publication fields.
          if (mirror.type === 'sermon' && mirror.mediaItem) {
            return { mediaItem: current, name: current.title, images: current.images };
          }
          return canonicalMirrorPatch(current, mirror, [
            'dateString',
            'trimDurationSeconds',
            'subsplashId',
            'audioSource',
            'audioArtifacts',
            'subsplashAudioUrl',
            'soundCloudTrackId',
            'soundCloudTrackUrl',
            'soundCloudPublication',
            'uploaderId',
            'approverId',
            'youtubeUrl',
            'seriesId',
          ]);
        },
      });
      await acknowledgeAlgoliaSync(sermonId);
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default sermonWriteTrigger;
