import { doc, getFirestore, updateDoc } from 'firebase/firestore';
import { firebase } from '../../firebase/firebase';

import { getAuth } from 'firebase/auth';
import { sermonConverter } from '../../types/Sermon';

interface editSermonProps {
  key: string;
  title: string;
  subtitle: string;
  date: Date;
  description: string;
  series: string;
  speaker: Array<string>;
  scripture: string;
  topic: Array<string>;
}

const editSermon = async (props: editSermonProps) => {
  getAuth();
  const db = getFirestore(firebase);
  const sermonRef = doc(db, 'sermons', props.key);

  await updateDoc(sermonRef.withConverter(sermonConverter), {
    title: props.title,
    subtitle: props.subtitle,
    dateMillis: props.date.getTime(),
    description: props.description,
    series: props.series,
    speaker: props.speaker,
    scripture: props.scripture,
    topic: props.topic,
  });
};

export default editSermon;
