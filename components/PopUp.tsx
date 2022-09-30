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
  onClose?: () => void;
}

const PopUp = (props: PopUpInfo) => {
  const { title, children, open, setOpen } = props;

  const onClose = () => {
    setOpen(false);
    props.onClose?.();
  };

  return (
    <Dialog open={open} onClose={onClose} aria-labelledby="confirm-dialog">
      <DialogTitle id="confirm-dialog">{title}</DialogTitle>
      <DialogContent>{children}</DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onClose} color="primary">
          {props.button ? 'Cancel' : 'Close'}
        </Button>
        {props.button}
      </DialogActions>
    </Dialog>
  );
};
export default PopUp;
