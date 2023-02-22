import firestore, { doc, updateDoc } from '../../firebase/firestore';

import { sermonConverter } from '../../types/Sermon';
import { Sermon } from '../../types/SermonTypes';
import { createFunction } from '../../utils/createFunction';
import { EDIT_SUBSPLASH_SERMON_INCOMING_DATA } from '../../functions/src/editSubsplashSermon';
import { EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA } from '../../functions/src/editSoundCloudSermon';
interface IEditSermon extends Omit<Sermon, 'status' | 'durationSeconds'> {}

const editSermon = async (props: IEditSermon) => {
  const promises: Promise<any>[] = [];
  if (props.subsplashId) {
    const editSubsplashSermon = createFunction<EDIT_SUBSPLASH_SERMON_INCOMING_DATA>('editSubsplashSermon');
    const input: EDIT_SUBSPLASH_SERMON_INCOMING_DATA = {
      subsplashId: props.subsplashId,
      title: props.title,
      subtitle: props.subtitle,
      description: props.description,
      speakers: props.speakers,
      topics: props.topics,
      images: props.images,
      date: new Date(props.dateMillis),
    };
    promises.push(editSubsplashSermon(input));
  }

  if (props.soundCloudTrackId) {
    const editSoundCloudSermon = createFunction<EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA>('editSoundCloudSermon');
    const data: EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA = {
      trackId: props.soundCloudTrackId,
      title: props.title,
      description: props.description,
      tags: [props.subtitle, ...props.topics],
      speakers: props.speakers.map((speaker) => speaker.name),
      imageUrl: props.images.find((image) => image.type === 'square')?.downloadLink,
    };
    promises.push(editSoundCloudSermon(data));
  }

  const sermonRef = doc(firestore, 'sermons', props.key).withConverter(sermonConverter);
  promises.push(
    updateDoc(sermonRef.withConverter(sermonConverter), {
      title: props.title,
      subtitle: props.subtitle,
      description: props.description,
      series: props.series,
      speakers: props.speakers,
      topics: props.topics,
      images: props.images,
      dateMillis: props.dateMillis,
    })
  );
  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      alert(result.reason);
    }
  }
};
export default editSermon;
