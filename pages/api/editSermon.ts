import firestore, { doc, updateDoc } from '../../firebase/firestore';

import { Sermon, sermonConverter } from '../../types/Sermon';

interface IEditSermon extends Omit<Sermon, 'status' | 'durationSeconds' | 'dateMillis'> {}

const editSermon = async (props: IEditSermon) => {
  const sermonRef = doc(firestore, 'sermons', props.key);

  await updateDoc(sermonRef.withConverter(sermonConverter), {
    title: props.title,
    subtitle: props.subtitle,
    description: props.description,
    series: props.series,
    speakers: props.speakers,
    scripture: props.scripture,
    topics: props.topics,
  });
};

export default editSermon;
