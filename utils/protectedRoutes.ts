import { GetServerSidePropsContext } from 'next';
import ProtectedRoute from '../components/ProtectedRoute';

export async function adminProtected(ctx: GetServerSidePropsContext) {
  const userCredentials = await ProtectedRoute(ctx);
  if (!userCredentials.props.uid || userCredentials.props.customClaims?.role !== 'admin') {
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
      props: {},
    };
  }
  return {
    props: {},
  };
}
