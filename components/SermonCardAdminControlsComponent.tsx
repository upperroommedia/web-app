import Image from 'next/image';

import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import IconButton from '@mui/material/IconButton';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/system/Box';
import UnpublishedIcon from '@mui/icons-material/Unpublished';
import Tooltip from '@mui/material/Tooltip';
import SoundCloudLogo from '../public/soundcloud.png';
import EditSermonForm from './EditSermonForm';
import DeleteEntityPopup from './DeleteEntityPopup';
import { Dispatch, FunctionComponent, SetStateAction, useEffect, useState } from 'react';
import { Sermon, reviewStatusType, uploadStatus } from '../types/SermonTypes';
import ManageUploadsPopup from './ManageUploadsPopup';
import { isDevelopment } from '../firebase/firebase';
import CountOfUploadsCircularProgress from './CountOfUploadsCircularProgress';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import ProvideFeedbackPopup from './ProvideFeebackPopup';

interface SermonCardAdminControlsComponentProps {
  sermon: Sermon;
  isUploadingToSubsplash: boolean;
  isUploadingToSoundCloud: boolean;
  manageUploadsPopup: boolean;
  setManageUploadsPopup: (boolean: boolean) => void;
  setIsUploadingToSubsplash: Dispatch<SetStateAction<boolean>>;
  handleDelete: () => Promise<void>;
  uploadToSoundCloud: () => Promise<void>;
  deleteFromSoundCloud: () => Promise<void>;
  deleteFromSubsplash: () => Promise<void>;
  approveSermon: () => Promise<void>;
  rejectSermon: (feedback: string) => Promise<void>;
  provideFeedbackPopup: boolean;
  setProvideFeedbackPopup: Dispatch<SetStateAction<boolean>>;
}

const SermonCardAdminControlsComponent: FunctionComponent<SermonCardAdminControlsComponentProps> = ({
  sermon,
  isUploadingToSoundCloud,
  isUploadingToSubsplash,
  manageUploadsPopup,
  setManageUploadsPopup,
  setIsUploadingToSubsplash,
  handleDelete,
  uploadToSoundCloud,
  deleteFromSoundCloud,
  deleteFromSubsplash,
  approveSermon,
  rejectSermon,
  provideFeedbackPopup,
  setProvideFeedbackPopup,
}: SermonCardAdminControlsComponentProps) => {
  const [deleteConfirmationPopup, setDeleteConfirmationPopup] = useState<boolean>(false);
  const [editFormPopup, setEditFormPopup] = useState<boolean>(false);
  const [disableButtons, setDisableButtons] = useState<boolean>(false);

  useEffect(() => {
    setDisableButtons(isUploadingToSoundCloud || isUploadingToSubsplash);
  }, [isUploadingToSoundCloud, isUploadingToSubsplash]);
  return (
    <>
      <Box display="flex" alignItems="center">
        {sermon.reviewStatus !== reviewStatusType.APPROVED && (
          <>
            <Tooltip title="Approve Sermon">
              <span>
                <IconButton onClick={approveSermon}>
                  <CheckIcon style={{ color: 'green' }} />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Reject Sermon">
              <span>
                <IconButton onClick={() => setProvideFeedbackPopup(true)}>
                  <CloseIcon style={{ color: 'red' }} />
                </IconButton>
              </span>
            </Tooltip>
          </>
        )}

        {isUploadingToSoundCloud ? (
          <CircularProgress size={24} sx={{ margin: 1 }} />
        ) : sermon.status.soundCloud === uploadStatus.UPLOADED ? (
          <Tooltip title="Remove From Soundcloud">
            <span>
              <IconButton aria-label="Remove from Soundcloud" disabled={disableButtons} onClick={deleteFromSoundCloud}>
                <UnpublishedIcon style={{ color: 'orangered' }} />
              </IconButton>
            </span>
          </Tooltip>
        ) : (
          <Tooltip title={isDevelopment ? 'Cannot upload to Soundcloud from dev environment' : 'Upload to Soundcloud'}>
            <span>
              <IconButton disabled={disableButtons || isDevelopment} onClick={() => uploadToSoundCloud()}>
                <Image src={SoundCloudLogo} alt="Soundcloud Logo" width={24} height={24} />
              </IconButton>
            </span>
          </Tooltip>
        )}
        {isUploadingToSubsplash ? (
          <CircularProgress size={24} sx={{ margin: 1 }} />
        ) : !sermon.numberOfLists ? (
          <Tooltip title="This sermon is not added to any lists. Please edit the sermon to add it to lists.">
            <span>
              <IconButton disabled>
                <ErrorOutlineIcon style={{ color: 'orange' }} />
              </IconButton>
            </span>
          </Tooltip>
        ) : (
          <Tooltip title="Manage Upload">
            <span>
              <IconButton
                disabled={disableButtons}
                aria-label="Upload to Subsplash"
                style={{ color: 'lightgreen' }}
                onClick={() => {
                  setManageUploadsPopup(true);
                }}
              >
                <CountOfUploadsCircularProgress sermon={sermon} size={30} />
              </IconButton>
            </span>
          </Tooltip>
        )}
        <Tooltip title="Edit Sermon">
          <span>
            <IconButton
              disabled={disableButtons}
              aria-label="edit sermon"
              style={{ color: 'lightblue' }}
              onClick={() => setEditFormPopup(true)}
            >
              <EditIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Delete Sermon From All Systems">
          <span>
            <IconButton
              disabled={disableButtons}
              aria-label="delete sermon"
              style={{ color: 'red' }}
              onClick={() => setDeleteConfirmationPopup(true)}
            >
              <DeleteIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      {manageUploadsPopup && (
        <ManageUploadsPopup
          sermon={sermon}
          manageUploadsPopupBoolean={manageUploadsPopup}
          setManageUploadsPopupBoolean={setManageUploadsPopup}
          setIsUploadingToSubsplash={setIsUploadingToSubsplash}
          deleteFromSubsplash={deleteFromSubsplash}
        />
      )}
      {deleteConfirmationPopup && (
        <DeleteEntityPopup
          entityBeingDeleten="sermon"
          handleDelete={handleDelete}
          deleteConfirmationPopup={deleteConfirmationPopup}
          setDeleteConfirmationPopup={setDeleteConfirmationPopup}
          isDeleting={isUploadingToSubsplash}
        />
      )}
      {provideFeedbackPopup && (
        <ProvideFeedbackPopup
          provideFeedbackPopup={provideFeedbackPopup}
          setProvideFeedbackPopup={setProvideFeedbackPopup}
          handleReject={rejectSermon}
        />
      )}
      {editFormPopup && <EditSermonForm open={editFormPopup} setOpen={() => setEditFormPopup(false)} sermon={sermon} />}
    </>
  );
};

export default SermonCardAdminControlsComponent;
