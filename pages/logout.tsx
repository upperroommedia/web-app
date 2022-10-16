/**
 * Page for Logg to use to upload, trim, and add intro/outro to audio file
 */
import type { NextPage } from 'next';
import { useEffect } from 'react';
import { useRouter } from 'next/router';
import useAuth from '../context/user/UserContext';

const Logout: NextPage = (_props) => {
  const router = useRouter();
  const { logoutUser } = useAuth();

  useEffect(() => {
    logoutUser();
    router.push('/');
  }, []);

  return <></>;
};

export default Logout;
