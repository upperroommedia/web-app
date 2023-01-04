import { Button, Checkbox } from '@mui/material';
import { Dispatch, SetStateAction, useState } from 'react';
import PopUp from './PopUp';

interface DeleteEntityPopupProps {
  entityBeingDeleten: string;
  deleteConfirmationPopup: boolean;
  setDeleteConfirmationPopup: Dispatch<SetStateAction<boolean>>;
  handleDelete: () => Promise<void>;
}

const DeleteEntityPopup = (props: DeleteEntityPopupProps) => {
  const [deleteChecked, setDeleteChecked] = useState<boolean>(false);
  return (
    <PopUp
      title={`Are you sure you want to permanently delete this ${props.entityBeingDeleten}?`}
      open={props.deleteConfirmationPopup}
      setOpen={props.setDeleteConfirmationPopup}
      button={
        <Button
          aria-label={`confirm delete ${props.entityBeingDeleten}`}
          variant="contained"
          onClick={async () => {
            await props.handleDelete();
            props.setDeleteConfirmationPopup(false);
            setDeleteChecked(false);
          }}
          color="primary"
          disabled={!deleteChecked}
        >
          Delete Forever
        </Button>
      }
    >
      <div>
        <div style={{ display: 'flex' }} onClick={() => setDeleteChecked((previousValue) => !previousValue)}>
          <Checkbox checked={deleteChecked} />
          <p style={{ cursor: 'pointer' }}>I understand that deleting is permanent and cannot be undone</p>
        </div>
      </div>
    </PopUp>
  );
};

export default DeleteEntityPopup;
