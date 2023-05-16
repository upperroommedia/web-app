import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Dialog from '@mui/material/Dialog';
import Button from '@mui/material/Button';
import { Sermon } from '../types/SermonTypes';
import { useCollectionDataOnce } from 'react-firebase-hooks/firestore';
import { collection } from 'firebase/firestore';
import firestore from '../firebase/firestore';
import { listConverter } from '../types/List';
import UploaderComponent from '../app/uploader/uploaderComponent';
// import Box from '@mui/material/Box';
// import CircularProgress from '@mui/material/CircularProgress';

interface EditSermonFormInfo {
  open: boolean;
  setOpen: any;
  sermon: Sermon;
}

const EditSermonForm = ({ sermon, open, setOpen }: EditSermonFormInfo) => {
  const [sermonLists, _loading, _error, _snapshot] = useCollectionDataOnce(
    collection(firestore, `sermons/${sermon.id}/sermonLists`).withConverter(listConverter)
  );

  return (
    <Dialog open={open} onClose={() => setOpen(false)} aria-labelledby="confirm-dialog" maxWidth="lg">
      <DialogContent>
        {/* {error ? (
          <Box>{error.message}</Box>
        ) : loading ? (
          <CircularProgress />
        ) : ( */}
        <UploaderComponent existingSermon={sermon} existingList={sermonLists || []} setEditFormOpen={setOpen} />
        {/* )} */}
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
