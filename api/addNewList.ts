import firestore, { setDoc, collection, doc } from '../firebase/firestore';
import { listConverter, List } from '../types/List';

const addNewList = async (list: List) => {
  // create series on firestore
  const newSeriesRef = doc(collection(firestore, 'lists')).withConverter(listConverter);
  await setDoc(newSeriesRef, { ...list, id: newSeriesRef.id });
  return newSeriesRef.id;
};

export default addNewList;
