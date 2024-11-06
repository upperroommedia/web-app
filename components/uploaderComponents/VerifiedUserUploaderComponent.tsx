import React, { Dispatch, SetStateAction } from 'react';
import useAuth from '../../context/user/UserContext';
import { useRouter } from 'next/router';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import RequestRoleChange from '../RequestUploadPrivalige';
import Uploader from './UploaderComponent';
import { SermonURL } from '../EditSermonForm';
import { Sermon } from '../../types/SermonTypes';
import { List } from '../../types/List';

export interface VerifiedUserUploaderProps {
  existingSermon?: Sermon;
  existingSermonUrl?: SermonURL;
  existingList?: List[];
  onCancel?: () => void;
  setEditFormOpen?: Dispatch<SetStateAction<boolean>>;
}

export default function VerifiedUserUploaderComponent(props: VerifiedUserUploaderProps) {
  const { user } = useAuth();
  const router = useRouter();
  if (!user) {
    router.push('/login');
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
