import firestore, { doc, setDoc } from '../../firebase/firestore';
import { v4 } from 'uuid';
import { Series } from '../../types/Series';

const addNewSeries = async (series: Series) => {
  const id = v4();
  await setDoc(doc(firestore, 'series', id), {
    id,
    name: series.name,
    sermonIds: [],
    images: series.images,
  });
  return id;
};

export default addNewSeries;
