import firestore, { collection, doc, getDocs, updateDoc, writeBatch } from '../../firebase/firestore';

import { sermonConverter } from '../../types/Sermon';
import { Sermon } from '../../types/SermonTypes';
import { createFunction } from '../../utils/createFunction';
import { EDIT_SUBSPLASH_SERMON_INCOMING_DATA } from '../../functions/src/editSubsplashSermon';
import { EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA } from '../../functions/src/editSoundCloudSermon';
import { Series, seriesConverter } from '../../types/Series';

const editSermon = async (sermon: Sermon, sermonSeries: Series[]) => {
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
      imageUrl: sermon.images.find((image) => image.type === 'square')?.downloadLink,
    };
    promises.push(editSoundCloudSermon(data));
  }

  const sermonRef = doc(firestore, 'sermons', sermon.key).withConverter(sermonConverter);
  promises.push(
    updateDoc(sermonRef.withConverter(sermonConverter), {
      title: sermon.title,
      subtitle: sermon.subtitle,
      description: sermon.description,
      speakers: sermon.speakers,
      topics: sermon.topics,
      images: sermon.images,
      dateMillis: sermon.dateMillis,
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
    collection(firestore, `sermons/${sermonRef.id}/sermonSeries`).withConverter(seriesConverter)
  );

  const seriesInFirebase = new Set<string>();
  const batch = writeBatch(firestore);
  sermonSeriesSnapshot.forEach((snapshot) => {
    if (sermonSeries.find((series) => series.id === snapshot.id)) {
      // series exists in both lists
      seriesInFirebase.add(snapshot.id);
    } else {
      // series exists in firebase but not updated list
      batch.delete(doc(firestore, `series/${snapshot.id}/seriesSermons/${sermon.key}`));
    }
  });

  // add any new series to firebase
  sermonSeries.forEach((series) => {
    if (!seriesInFirebase.has(series.id)) {
      batch.set(doc(firestore, `series/${series.id}/seriesSermons/${sermon.key}`), sermon);
    }
  });
  await batch.commit();
};
export default editSermon;
