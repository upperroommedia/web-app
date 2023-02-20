import type { GetServerSidePropsContext } from 'next';
import firebaseAdmin from '../firebase/firebaseAdmin';
import nookies from 'nookies';

export default async function ProtectedRoute(context: GetServerSidePropsContext) {
  try {
    const cookies = nookies.get(context);
    console.log('cookies', cookies);
    const token = await firebaseAdmin.auth().verifyIdToken(cookies.token);
    console.log('token', token);
    const user = await firebaseAdmin.auth().getUser(token.uid);
    console.log('user', user);
    return {
      props: { ...user },
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
