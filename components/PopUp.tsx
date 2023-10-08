import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Dialog, { DialogProps } from '@mui/material/Dialog';
import Button from '@mui/material/Button';
import DialogTitle from '@mui/material/DialogTitle';
import { ReactElement } from 'react';

interface PopUpInfo {
  title?: string;
  open: boolean;
  children: string | ReactElement;
  setOpen: (setOpen: boolean) => void;
  button?: ReactElement;
  onClose?: () => void;
  // optional props to pass to Dialog
  dialogProps?: Omit<DialogProps, 'open'>;
}

const PopUp = (props: PopUpInfo) => {
  const { title, children, open, setOpen } = props;

  const onClose = () => {
    setOpen(false);
    props.onClose?.();
  };

  return (
    <Dialog open={open} onClose={onClose} {...props.dialogProps} aria-labelledby="confirm-dialog">
      {title && <DialogTitle id="confirm-dialog">{title}</DialogTitle>}
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
