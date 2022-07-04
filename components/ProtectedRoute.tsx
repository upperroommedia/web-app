import type { GetServerSidePropsContext } from 'next';
import { firebaseAdmin } from '../firebase/firebaseAdmin';
import nookies from 'nookies';

export default async function ProtectedRoute(
  context: GetServerSidePropsContext
) {
  try {
    const cookies = nookies.get(context);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(cookies, null, 2));
    const token = await firebaseAdmin.auth().verifyIdToken(cookies.token);
    return {
      props: { token },
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
