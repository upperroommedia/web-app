import type { GetServerSidePropsContext } from 'next';
import { adminAuth } from '../firebase/initFirebaseAdmin';
import nookies from 'nookies';

export default async function ProtectedRoute(context: GetServerSidePropsContext) {
  try {
    const cookies = nookies.get(context);
    const token = await adminAuth.verifyIdToken(cookies.token);
    const user = await adminAuth.getUser(token.uid);
    return {
      props: { ...user },
    };
  } catch (err) {
    // User is not authenticated
    return {
      redirect: {
        permanent: false,
        destination: `/login?callbackurl=${context.resolvedUrl}`,
      },
      props: {} as never,
    };
  }
}
