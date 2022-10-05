import type { GetServerSidePropsContext } from 'next';
import { firebaseAdmin } from '../firebase/firebaseAdmin';
import nookies from 'nookies';
import { doc, getDoc, getFirestore } from 'firebase/firestore';
import { firebase } from '../firebase/firebase';

export default async function ProtectedRoute(context: GetServerSidePropsContext) {
  const db = getFirestore(firebase);
  try {
    const cookies = nookies.get(context);

    const token = await firebaseAdmin.auth().verifyIdToken(cookies.token);

    const userRef = doc(db, 'users', token.uid);
    const userSnap = await getDoc(userRef);
    const user = userSnap.data();
    return {
      props: { token, user },
    };
  } catch (err) {
    // User is not authenticated
    return {
      redirect: {
        permanent: false,
        destination: '/login',
      },
      props: {} as never,
    };
  }
}
