import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Dialog from '@mui/material/Dialog';
import Button from '@mui/material/Button';
import Uploader from '../pages/uploader';
import { Sermon } from '../types/SermonTypes';
import { useCollectionDataOnce } from 'react-firebase-hooks/firestore';
import { collection } from 'firebase/firestore';
import firestore from '../firebase/firestore';
// import Box from '@mui/material/Box';
// import CircularProgress from '@mui/material/CircularProgress';
import { seriesConverter } from '../types/Series';

interface EditSermonFormInfo {
  open: boolean;
  setOpen: any;
  sermon: Sermon;
}

const EditSermonForm = ({ sermon, open, setOpen }: EditSermonFormInfo) => {
  const [sermonSeries, _loading, _error, _snapshot] = useCollectionDataOnce(
    collection(firestore, `sermons/${sermon.key}/sermonSeries`).withConverter(seriesConverter)
  );

  return (
    <Dialog open={open} onClose={() => setOpen(false)} aria-labelledby="confirm-dialog" maxWidth="lg">
      <DialogContent>
        {/* {error ? (
          <Box>{error.message}</Box>
        ) : loading ? (
          <CircularProgress />
        ) : ( */}
        <Uploader existingSermon={sermon} existingSeries={sermonSeries || []} setEditFormOpen={setOpen} />
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
