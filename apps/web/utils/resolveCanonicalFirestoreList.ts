import { collection, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore';
import firestore from '../firebase/firestore';
import { List, listConverter } from '../types/List';

export async function resolveCanonicalFirestoreList(inputList: List): Promise<List | null> {
  const directSnapshot = await getDoc(doc(firestore, 'lists', inputList.id).withConverter(listConverter));
  if (directSnapshot.exists()) {
    return directSnapshot.data();
  }

  const candidateSubsplashIds = [inputList.subsplashId, inputList.id]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const candidateSubsplashId of candidateSubsplashIds) {
    const bySubsplashSnapshot = await getDocs(
      query(collection(firestore, 'lists'), where('subsplashId', '==', candidateSubsplashId), limit(2)).withConverter(listConverter)
    );

    if (bySubsplashSnapshot.docs.length > 1) {
      throw new Error(`Multiple Firestore lists already exist for Subsplash list ${candidateSubsplashId}.`);
    }

    if (bySubsplashSnapshot.docs[0]) {
      return bySubsplashSnapshot.docs[0].data();
    }
  }

  return null;
}
