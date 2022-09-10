/**
 * Page for Logg to use to upload, trim, and add intro/outro to audio file
 */
import type { NextPage } from 'next';
import { useContext, useEffect } from 'react';
import UserContext from '../context/user/UserContext';
import { useRouter } from 'next/router';

const Logout: NextPage = (_props) => {
  const router = useRouter();
  const { logoutUser } = useContext(UserContext);

  useEffect(() => {
    logoutUser();
    router.push('/');
  }, []);

  return <></>;
};

export default Logout;
