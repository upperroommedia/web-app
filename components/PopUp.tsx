import {
  DialogTitle,
  DialogContent,
  DialogActions,
  Dialog,
  Button,
} from '@mui/material';

interface PopUpInfo {
  title: string;
  open: boolean;
  children: string;
  setOpen: any;
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
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
};
export default PopUp;
