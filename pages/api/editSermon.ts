import firestore, { doc, updateDoc } from '../../firebase/firestore';

import { sermonConverter } from '../../types/Sermon';
import { Sermon } from '../../types/SermonTypes';
import { createFunction } from '../../utils/createFunction';
import { EDIT_SERMON_INCOMING_DATA } from '../../functions/src/editSermon';

interface IEditSermon extends Omit<Sermon, 'status' | 'durationSeconds'> {}

const editSermon = async (props: IEditSermon) => {
  const promises: Promise<any>[] = [];
  if (props.subsplashId) {
    const editSubsplashSermon = createFunction<EDIT_SERMON_INCOMING_DATA>('editSermon');
    const input: EDIT_SERMON_INCOMING_DATA = {
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
    if (result.status === 'fulfilled') {
      console.log(result.status);
    } else {
      console.error(result.reason);
    }
  }
};

export default editSermon;
