import Button from '@material-ui/core/Button';
import Dialog from '@material-ui/core/Dialog';
import DialogActions from '@material-ui/core/DialogActions';
import DialogContent from '@material-ui/core/DialogContent';
import DialogTitle from '@material-ui/core/DialogTitle';

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
          color="default"
        >
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
};
export default PopUp;
