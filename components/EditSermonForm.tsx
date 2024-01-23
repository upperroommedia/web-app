import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Dialog from '@mui/material/Dialog';
import Button from '@mui/material/Button';
import VerifiedUserUploader from './uploaderComponents/VerifiedUserUploaderComponent';
import { Sermon } from '../types/SermonTypes';
import { useCollectionDataOnce } from 'react-firebase-hooks/firestore';
import { collection } from 'firebase/firestore';
import firestore from '../firebase/firestore';
import firebase from '../firebase/firebase';
import { listConverter } from '../types/List';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import { useEffect, useMemo, useState } from 'react';
import { getDownloadURL, getStorage, ref } from '../firebase/storage';
import { PROCESSED_SERMONS_BUCKET } from '../constants/storage_constants';
import { showAudioTrimmerBoolean } from './uploaderComponents/utils';

interface EditSermonFormInfo {
  open: boolean;
  setOpen: any;
  sermon: Sermon;
}

export type SermonURL =
  | {
      url: string;
      status: 'success';
    }
  | {
      url: undefined;
      status: 'loading' | 'error';
    };
const storage = getStorage(firebase);
const EditSermonForm = ({ sermon, open, setOpen }: EditSermonFormInfo) => {
  const [sermonLists, loading, error, _snapshot] = useCollectionDataOnce(
    collection(firestore, `sermons/${sermon.id}/sermonLists`).withConverter(listConverter)
  );
  const [sermonUrl, setSermonUrl] = useState<SermonURL>({ url: undefined, status: 'loading' });

  const showAudioTrimmer = useMemo(() => {
    return showAudioTrimmerBoolean(sermon.status.soundCloud, sermon.status.subsplash)
}, [sermon.status.soundCloud, sermon.status.subsplash])

  useEffect(() => {
    if (!showAudioTrimmer) return;
    getDownloadURL(ref(storage, `${PROCESSED_SERMONS_BUCKET}/${sermon.id}`))
      .then((url) => {
        setSermonUrl({ url, status: 'success' });
      })
      .catch((error) => {
        setSermonUrl({ url: undefined, status: 'error' });
        // eslint-disable-next-line no-console
        console.log(error);
      });
  }, [sermon.id, showAudioTrimmer]);

  return (
    <Dialog open={open} onClose={() => setOpen(false)} aria-labelledby="confirm-dialog" maxWidth="lg">
      <DialogContent>
        {error ? (
          <Box>{error.message}</Box>
        ) : loading ? (
          <CircularProgress />
        ) : (
          <VerifiedUserUploader
            existingSermon={sermon}
            existingList={sermonLists || []}
            existingSermonUrl={sermonUrl}
            setEditFormOpen={setOpen}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button
          variant="contained"
          onClick={() => {
            setOpen(false);
          }}
          color="primary"
        >
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
};
export default EditSermonForm;
