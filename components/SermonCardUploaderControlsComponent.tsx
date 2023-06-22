import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import RemoveDoneIcon from '@mui/icons-material/RemoveDone';
import UploadIcon from '@mui/icons-material/Upload';
import CloseIcon from '@mui/icons-material/Close';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/system/Box';
import Tooltip from '@mui/material/Tooltip';
import EditSermonForm from './EditSermonForm';
import DeleteEntityPopup from './DeleteEntityPopup';
import { FunctionComponent, useState } from 'react';
import { Sermon, reviewStatusType } from '../types/SermonTypes';
import PopUp from './PopUp';

interface SermonCardUploaderControlsComponentProps {
  sermon: Sermon;
  submitSermonForReview: () => Promise<void>;
  removeSermonFromReview: () => Promise<void>;
  handleDelete: () => Promise<void>;
}

const SermonCardUploaderControlsComponent: FunctionComponent<SermonCardUploaderControlsComponentProps> = ({
  sermon,
  submitSermonForReview,
  removeSermonFromReview,
  handleDelete,
}: SermonCardUploaderControlsComponentProps) => {
  const [deleteConfirmationPopup, setDeleteConfirmationPopup] = useState<boolean>(false);
  const [editFormPopup, setEditFormPopup] = useState<boolean>(false);
  const [viewFeedbackPopup, setViewFeedbackPopup] = useState<boolean>(false);

  return (
    <>
      <Box display="flex" alignItems="center">
        {sermon.reviewStatus === reviewStatusType.APPROVED && (
          <Tooltip title="Sermon approved!">
            <span>
              <DoneAllIcon />
            </span>
          </Tooltip>
        )}
        {sermon.reviewStatus === reviewStatusType.REJECTED && (
          <Tooltip title="Sermon Was Rejected">
            <span>
              <IconButton
                aria-label="sermon was rejected"
                style={{ color: 'red' }}
                onClick={() => setViewFeedbackPopup(true)}
              >
                <CloseIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
        {(sermon.reviewStatus === reviewStatusType.EDITING || sermon.reviewStatus === reviewStatusType.REJECTED) && (
          <Tooltip title="Submit Sermon For Review">
            <span>
              <IconButton aria-label="submit sermon" style={{ color: 'green' }} onClick={submitSermonForReview}>
                <UploadIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
        {sermon.reviewStatus === reviewStatusType.IN_REVIEW && (
          <Tooltip title="Remove Sermon From Review">
            <span>
              <IconButton aria-label="unsubmit sermon" style={{ color: 'red' }} onClick={removeSermonFromReview}>
                <RemoveDoneIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
        <Tooltip title="Edit Sermon">
          <span>
            <IconButton aria-label="edit sermon" style={{ color: 'lightblue' }} onClick={() => setEditFormPopup(true)}>
              <EditIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Delete Sermon From All Systems">
          <span>
            <IconButton
              aria-label="delete sermon"
              style={{ color: 'red' }}
              onClick={() => setDeleteConfirmationPopup(true)}
            >
              <DeleteIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      {deleteConfirmationPopup && (
        <DeleteEntityPopup
          entityBeingDeleten="sermon"
          handleDelete={handleDelete}
          deleteConfirmationPopup={deleteConfirmationPopup}
          setDeleteConfirmationPopup={setDeleteConfirmationPopup}
          //   TODO: FIX
          isDeleting={false}
        />
      )}
      {editFormPopup && <EditSermonForm open={editFormPopup} setOpen={() => setEditFormPopup(false)} sermon={sermon} />}
      {viewFeedbackPopup && sermon.reviewFeedback && (
        <PopUp open={viewFeedbackPopup} setOpen={() => setViewFeedbackPopup(false)}>
          {sermon.reviewFeedback}
        </PopUp>
      )}
    </>
  );
};

export default SermonCardUploaderControlsComponent;
