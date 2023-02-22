import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Dialog from '@mui/material/Dialog';
import Button from '@mui/material/Button';
import Uploader from '../pages/uploader';
import { Sermon } from '../types/SermonTypes';

interface EditSermonFormInfo {
  open: boolean;
  setOpen: any;
  sermon: Sermon;
}

const EditSermonForm = (props: EditSermonFormInfo) => {
  const { sermon, open, setOpen } = props;

  return (
    <Dialog open={open} onClose={() => setOpen(false)} aria-labelledby="confirm-dialog" maxWidth="lg">
      <DialogContent>
        <Uploader existingSermon={sermon} setEditFormOpen={setOpen} />
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
