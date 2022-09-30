import type { GetServerSidePropsContext } from 'next';
import { firebaseAdmin } from '../firebase/firebaseAdmin';
import nookies from 'nookies';

export default async function ProtectedRoute(context: GetServerSidePropsContext) {
  try {
    const cookies = nookies.get(context);

    const token = await firebaseAdmin.auth().verifyIdToken(cookies.token);
    return {
      props: { token: token },
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
