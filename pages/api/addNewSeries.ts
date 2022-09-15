import { doc, getFirestore, setDoc } from 'firebase/firestore';
import { firebase } from '../../firebase/firebase';

const addNewSeries = async (value: string) => {
  const db = getFirestore(firebase);
  await setDoc(doc(db, 'series', value), {
    name: value,
  });
};

export default addNewSeries;
