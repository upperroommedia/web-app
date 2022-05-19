import { collection, getFirestore, query, getDocs } from 'firebase/firestore';
import { firebase } from '../../firebase/firebase';
import { getAuth } from 'firebase/auth';
getAuth();

const db = getFirestore(firebase);

const q = query(collection(db, 'speakers'));

// { value: 'chocolate', label: 'Chocolate' },
//   { value: 'strawberry', label: 'Strawberry' },
//   { value: 'vanilla', label: 'Vanilla' },

interface Speaker {
  readonly value: string;
  readonly label: string;
}

const speakers: Speaker[] = [];
export default async function fetchSpeakers() {
  const querySnapshot = await getDocs(q);
  querySnapshot.forEach((doc) => {
    // doc.data() is never undefined for query doc snapshots
    speakers.push({
      value: doc.data() as unknown as string,
      label: doc.data() as unknown as string,
    });
  });
  return speakers;
}
