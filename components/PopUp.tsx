import {
  DialogTitle,
  DialogContent,
  DialogActions,
  Dialog,
  Button,
} from '@mui/material';
import { ReactElement } from 'react';

interface PopUpInfo {
  title: string;
  open: boolean;
  children: string | ReactElement;
  setOpen: any;
  button?: ReactElement;
}

const PopUp = (props: PopUpInfo) => {
  const { title, children, open, setOpen } = props;
  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      aria-labelledby="confirm-dialog"
    >
      <DialogTitle id="confirm-dialog">{title}</DialogTitle>
      <DialogContent>{children}</DialogContent>
      <DialogActions>
        <Button
          variant="contained"
          onClick={() => {
            setOpen(false);
          }}
          color="primary"
        >
          {props.button ? 'Cancel' : 'Close'}
        </Button>
        {props.button}
      </DialogActions>
    </Dialog>
  );
};
export default PopUp;
