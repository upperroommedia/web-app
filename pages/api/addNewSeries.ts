import firestore, { doc, setDoc } from '../../firebase/firestore';
import { v4 } from 'uuid';

const addNewSeries = async (value: string) => {
  const id = v4();
  await setDoc(doc(firestore, 'series', id), {
    id,
    name: value,
    sermonIds: [],
  });
  return id;
};

export default addNewSeries;
