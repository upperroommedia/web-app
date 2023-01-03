import firestore, { doc, setDoc } from '../../firebase/firestore';

const addNewSeries = async (value: string) => {
  await setDoc(doc(firestore, 'series', value), {
    name: value,
    sermonIds: [],
  });
};

export default addNewSeries;
