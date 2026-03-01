import firestore, {
  collection,
  collectionGroup,
  doc,
  getDocs,
  query,
  where,
  writeBatch,
  runTransaction,
  increment,
  orderBy,
  limit,
  updateDoc,
} from '../../firebase/firestore';

import { sermonConverter } from '../../types/Sermon';
import { Sermon } from '../../types/SermonTypes';
import { createFunctionV2 } from '../../utils/createFunction';
import { EDIT_SUBSPLASH_SERMON_INCOMING_DATA } from '../../functions/src/editSubsplashSermon';
import { EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA } from '../../functions/src/editSoundCloudSermon';
import { getSquareImageStoragePath } from '../../utils/utils';
import { List, listConverter } from '../../types/List';
import { buildEditableSermonPatch } from '../../utils/buildEditableSermonPatch';

interface EditSermonOptions {
  originalSeriesId?: string;
}

const editSermon = async (sermon: Sermon, sermonList: List[], options?: EditSermonOptions) => {
  const promises: Promise<any>[] = [];
  if (sermon.subsplashId) {
    const editSubsplashSermon = createFunctionV2<EDIT_SUBSPLASH_SERMON_INCOMING_DATA>('editSubsplashSermon');
    const input: EDIT_SUBSPLASH_SERMON_INCOMING_DATA = {
      subsplashId: sermon.subsplashId,
      title: sermon.title,
      subtitle: sermon.subtitle,
      description: sermon.description,
      speakers: sermon.speakers,
      topics: sermon.topics,
      images: sermon.images,
      date: new Date(sermon.dateMillis),
    };
    promises.push(editSubsplashSermon(input));
  }

  if (sermon.soundCloudTrackId) {
    const editSoundCloudSermon = createFunctionV2<EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA>('editSoundCloudSermon');
    const data: EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA = {
      trackId: sermon.soundCloudTrackId,
      title: sermon.title,
      description: sermon.description,
      tags: [sermon.subtitle, ...sermon.topics],
      speakers: sermon.speakers.map((speaker) => speaker.name),
      imageStoragePath: getSquareImageStoragePath(sermon),
    };
    promises.push(editSoundCloudSermon(data));
  }

  const sermonRef = doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter);
  promises.push(updateDoc(sermonRef, buildEditableSermonPatch(sermon)));
  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      alert(result.reason);
    }
  }

  // update sermonList
  const sermonListQuery = query(collectionGroup(firestore, 'listItems'), where('id', '==', sermonRef.id)).withConverter(
    listConverter
  );

  const sermonListDocs = await getDocs(sermonListQuery);
  const seriesListFromFirebase = sermonListDocs.docs.map((doc) => doc.ref.parent.parent?.id || '');

  const seriesInFirebase = new Set<string>();
  const batch = writeBatch(firestore);
  seriesListFromFirebase.forEach((listId) => {
    if (sermonList.find((series) => series.id === listId)) {
      // series exists in both lists
      seriesInFirebase.add(listId);
    } else {
      // series exists in firebase but not updated list
      batch.delete(doc(firestore, `lists/${listId}/listItems/${sermon.id}`));
    }
  });

  // add any new series to firebase
  sermonList.forEach((series) => {
    if (!seriesInFirebase.has(series.id)) {
      batch.set(doc(firestore, `lists/${series.id}/listItems/${sermon.id}`).withConverter(sermonConverter), sermon);
    }
  });
  await batch.commit();

  // Handle series (media series) changes - this is separate from lists
  // Uses a transaction to ensure atomicity of all series-related operations
  const originalSeriesId = options?.originalSeriesId;
  const newSeriesId = sermon.seriesId;
  
  // Only process if series has changed
  if (originalSeriesId !== newSeriesId) {
    try {
      let newSeriesPosition = 1;
      if (newSeriesId) {
        const latestPositionSnapshot = await getDocs(
          query(
            collection(firestore, `series/${newSeriesId}/seriesItems`),
            orderBy('position', 'desc'),
            limit(1)
          )
        );
        const latestPosition = latestPositionSnapshot.docs[0]?.data()?.position;
        newSeriesPosition = typeof latestPosition === 'number' ? latestPosition + 1 : 1;
      }

      await runTransaction(firestore, async (transaction) => {
        // Prepare document references
        const oldSeriesRef = originalSeriesId ? doc(firestore, 'series', originalSeriesId) : null;
        const oldSeriesItemRef = originalSeriesId 
          ? doc(firestore, 'series', originalSeriesId, 'seriesItems', sermon.id) 
          : null;
        const newSeriesRef = newSeriesId ? doc(firestore, 'series', newSeriesId) : null;
        const newSeriesItemRef = newSeriesId 
          ? doc(firestore, 'series', newSeriesId, 'seriesItems', sermon.id) 
          : null;

        // Read phase: get all documents we need to update
        const oldSeriesDoc = oldSeriesRef ? await transaction.get(oldSeriesRef) : null;
        const newSeriesDoc = newSeriesRef ? await transaction.get(newSeriesRef) : null;

        // Write phase: perform all updates atomically
        
        // Remove from old series if it existed
        if (oldSeriesItemRef) {
          transaction.delete(oldSeriesItemRef);
        }
        if (oldSeriesDoc?.exists()) {
          transaction.update(oldSeriesRef!, {
            itemCount: increment(-1),
            updatedAt: new Date(),
          });
        }

        // Add to new series if one is selected
        if (newSeriesItemRef && newSeriesDoc?.exists()) {
          transaction.set(newSeriesItemRef, {
            id: sermon.id,
            position: newSeriesPosition,
            publishedToSubsplash: false,
            sermonSubsplashId: sermon.subsplashId || null,
            addedAt: new Date(),
          });
          transaction.update(newSeriesRef!, {
            itemCount: increment(1),
            updatedAt: new Date(),
          });
        }
      });
    } catch (err) {
      console.error('Error updating series membership:', err);
      throw err; // Re-throw to let caller handle the error
    }
  }
};
export default editSermon;
