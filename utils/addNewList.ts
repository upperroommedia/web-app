import firestore, { setDoc, collection, doc } from '../firebase/firestore';
import { listConverter, List } from '../types/List';

export const addNewList = async (list: List) => {
  const newListRef = doc(collection(firestore, 'lists')).withConverter(listConverter);
  await setDoc(newListRef, { ...list, id: newListRef.id });
  return newListRef.id;
};

export default addNewList;
