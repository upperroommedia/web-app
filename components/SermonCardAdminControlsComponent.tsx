import Image from 'next/image';

import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/system/Box';
import PublishIcon from '@mui/icons-material/Publish';
import UnpublishedIcon from '@mui/icons-material/Unpublished';
import Tooltip from '@mui/material/Tooltip';
import SoundCloudLogo from '../public/soundcloud.png';
import EditSermonForm from './EditSermonForm';
import DeleteEntityPopup from './DeleteEntityPopup';
import { Dispatch, FunctionComponent, SetStateAction, useEffect, useState } from 'react';
import { Sermon, uploadStatus } from '../types/SermonTypes';
import UploadToSubsplashPopup from './ManageUploadsPopup';
import { isDevelopment } from '../firebase/firebase';

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
                <PublishIcon />
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
        <UploadToSubsplashPopup
          sermon={sermon}
          manageUploadsPopupBoolean={manageUploadsPopup}
          setManageUploadsPopupBoolean={setManageUploadsPopup}
          setIsUploadingToSubsplash={setIsUploadingToSubsplash}
          isUploadingToSubsplash={isUploadingToSubsplash}
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
      {editFormPopup && <EditSermonForm open={editFormPopup} setOpen={() => setEditFormPopup(false)} sermon={sermon} />}
    </>
  );
};

export default SermonCardAdminControlsComponent;
