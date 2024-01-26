import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/system/Box';
import Tooltip from '@mui/material/Tooltip';
import EditSermonForm from './EditSermonForm';
import DeleteEntityPopup from './DeleteEntityPopup';
import { Dispatch, FunctionComponent, SetStateAction, useEffect, useState } from 'react';
import { Sermon, uploadStatus } from '../types/SermonTypes';
import ManageUploadsPopup from './ManageUploadsPopup';
import ManageSoundcloudButton from './ManageSoundcloudButton';
import ManageSubsplashButton from './ManageSubsplashButton';
import useAuth from '../context/user/UserContext';
import Chip from '@mui/material/Chip';

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
  const { user } = useAuth();

  const showEditAndDelete =
    user?.isAdmin() ||
    (user?.isUploader() &&
      sermon.status.subsplash !== uploadStatus.UPLOADED &&
      sermon.status.soundCloud !== uploadStatus.UPLOADED);

  useEffect(() => {
    setDisableButtons(isUploadingToSoundCloud || isUploadingToSubsplash);
  }, [isUploadingToSoundCloud, isUploadingToSubsplash]);
  return (
    <>
      <Box display="flex" alignItems="center">
        {user?.isAdmin() && (
          <>
            <ManageSoundcloudButton
              sermon={sermon}
              isUploadingToSoundCloud={isUploadingToSoundCloud}
              disableButtons={disableButtons}
              uploadToSoundCloud={uploadToSoundCloud}
              deleteFromSoundCloud={deleteFromSoundCloud}
            />
            <ManageSubsplashButton
              sermonNumberOfListsUploadedTo={sermon.numberOfListsUploadedTo}
              sermonNumberOfLists={sermon.numberOfLists}
              isUploadingToSubsplash={isUploadingToSubsplash}
              disableButtons={disableButtons}
              setManageUploadsPopup={setManageUploadsPopup}
            />
          </>
        )}
        {showEditAndDelete ? (
          <>
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
          </>
        ) : (
          <Chip label="Uploaded" color="success" />
        )}
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
      {editFormPopup && <EditSermonForm open={editFormPopup} setOpen={() => setEditFormPopup(false)} sermon={sermon} />}
    </>
  );
};

export default SermonCardAdminControlsComponent;
