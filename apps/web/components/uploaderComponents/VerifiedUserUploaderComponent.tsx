import { type Dispatch, type SetStateAction, useEffect, useRef } from 'react';
import useAuth from '../../context/user/UserContext';
import Router from 'next/router';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import RequestRoleChange from '../RequestUploadPrivalige';
import dynamic from 'next/dynamic';
import type { SermonURL } from '../EditSermonForm';
import type { Sermon } from '../../types/SermonTypes';
import type { List } from '../../types/List';

const Uploader = dynamic(() => import('./UploaderComponent'), {
  ssr: false,
  loading: () => (
    <Stack sx={{ justifyContent: 'center', alignItems: 'center', margin: 8 }}>
      <CircularProgress />
    </Stack>
  ),
});

export interface VerifiedUserUploaderProps {
  existingSermon?: Sermon;
  existingSermonUrl?: SermonURL;
  existingList?: List[];
  setEditFormOpen?: Dispatch<SetStateAction<boolean>>;
}

export default function VerifiedUserUploaderComponent(props: VerifiedUserUploaderProps) {
  const { user, loading } = useAuth();
  const redirectingRef = useRef(false);
  const isAuthenticated = user != null;

  useEffect(() => {
    if (loading || isAuthenticated) {
      redirectingRef.current = false;
      return;
    }

    if (redirectingRef.current) {
      return;
    }
    redirectingRef.current = true;

    const callbackPath =
      typeof window !== 'undefined' && window.location.pathname !== '/login'
        ? `${window.location.pathname}${window.location.search}`
        : '/';

    Router.replace(`/login?callbackurl=${encodeURIComponent(callbackPath)}`);
  }, [loading, isAuthenticated]);

  if (loading || !user) {
    return (
      <Stack sx={{ justifyContent: 'center', alignItems: 'center', margin: 8 }}>
        <CircularProgress />
      </Stack>
    );
  } else if (!user.canUpload()) {
    return (
      <Stack sx={{ justifyContent: 'center', alignItems: 'center', margin: 8 }}>
        <Stack sx={{ justifyContent: 'center', alignItems: 'center', margin: 8 }}>
          <Typography variant="h2">You are not an uploader.</Typography>
          <Typography>In order to upload sermons, please contact the admin to be added as an uploader.</Typography>
        </Stack>
        <RequestRoleChange />
      </Stack>
    );
  }
  return <Uploader user={user} {...props} />;
}
