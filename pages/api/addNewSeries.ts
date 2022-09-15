import { doc, getFirestore, setDoc } from 'firebase/firestore';
import { firebase } from '../../firebase/firebase';
import { v4 as uuidv4 } from 'uuid';

const addNewSeries = async (value: string) => {
  const db = getFirestore(firebase);
  const id = uuidv4();
  await setDoc(doc(db, 'series', id), {
    name: value,
  });
};

export default addNewSeries;
