import firestore, { collection, doc, getDocs, setDoc, writeBatch } from '../firebase/firestore';

import { sermonConverter } from '../types/Sermon';
import { Sermon } from '../types/SermonTypes';
import { createFunction } from '../utils/createFunction';
import { EDIT_SUBSPLASH_SERMON_INCOMING_DATA } from '../functions/src/editSubsplashSermon';
import { EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA } from '../functions/src/editSoundCloudSermon';
import { getSquareImageStoragePath } from '../utils/utils';
import { List, listConverter } from '../types/List';

const editSermon = async (sermon: Sermon, sermonSeries: List[]) => {
  const promises: Promise<any>[] = [];
  if (sermon.subsplashId) {
    const editSubsplashSermon = createFunction<EDIT_SUBSPLASH_SERMON_INCOMING_DATA>('editSubsplashSermon');
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
    const editSoundCloudSermon = createFunction<EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA>('editSoundCloudSermon');
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
  promises.push(
    setDoc(sermonRef.withConverter(sermonConverter), {
      ...sermon,
    })
  );
  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      alert(result.reason);
    }
  }

  // update sermonSeries
  const sermonSeriesSnapshot = await getDocs(
    collection(firestore, `lists/${sermonRef.id}/listItems`).withConverter(listConverter)
  );

  const seriesInFirebase = new Set<string>();
  const batch = writeBatch(firestore);
  sermonSeriesSnapshot.forEach((snapshot) => {
    if (sermonSeries.find((series) => series.id === snapshot.id)) {
      // series exists in both lists
      seriesInFirebase.add(snapshot.id);
    } else {
      // series exists in firebase but not updated list
      batch.delete(doc(firestore, `lists/${snapshot.id}/listItems/${sermon.id}`));
    }
  });

  // add any new series to firebase
  sermonSeries.forEach((series) => {
    if (!seriesInFirebase.has(series.id)) {
      batch.set(doc(firestore, `lists/${series.id}/listItems/${sermon.id}`).withConverter(sermonConverter), sermon);
    }
  });
  await batch.commit();
};
export default editSermon;
