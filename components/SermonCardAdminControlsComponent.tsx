import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/system/Box';
import Tooltip from '@mui/material/Tooltip';
import { Dispatch, FunctionComponent, SetStateAction, useEffect, useState } from 'react';
import { Sermon, sermonStatusType, uploadStatus } from '../types/SermonTypes';
import ManageSoundcloudButton from './ManageSoundcloudButton';
import ManageSubsplashButton from './ManageSubsplashButton';
import useAuth from '../context/user/UserContext';
import Chip from '@mui/material/Chip';
import dynamic from 'next/dynamic';
import RetryProcessButton from './RetryProcessButton';
import Link from 'next/link';

const ManageUploadsPopup = dynamic(() => import('./ManageUploadsPopup'));
const DeleteEntityPopup = dynamic(() => import('./DeleteEntityPopup'));

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
  const [disableButtons, setDisableButtons] = useState<boolean>(false);
  const { user } = useAuth();

  const showDelete =
    (user?.isAdmin() && sermon.status.audioStatus !== sermonStatusType.PENDING) ||
    (user?.isUploader() &&
      sermon.status.subsplash !== uploadStatus.UPLOADED &&
      sermon.status.soundCloud !== uploadStatus.UPLOADED &&
      sermon.status.audioStatus !== sermonStatusType.PENDING);

  const showEdit =
    sermon.status.audioStatus === sermonStatusType.PROCESSED &&
    (user?.isAdmin() ||
      (user?.isUploader() &&
        sermon.status.subsplash !== uploadStatus.UPLOADED &&
        sermon.status.soundCloud !== uploadStatus.UPLOADED));

  const showUploadedTag =
    !user?.isAdmin() &&
    (sermon.status.subsplash === uploadStatus.UPLOADED || sermon.status.soundCloud === uploadStatus.UPLOADED);

  const showUploadButtons = user?.isAdmin() && sermon.status.audioStatus === sermonStatusType.PROCESSED;
  const showRetry = sermon.status.audioStatus === sermonStatusType.ERROR;

  useEffect(() => {
    setDisableButtons(isUploadingToSoundCloud || isUploadingToSubsplash);
  }, [isUploadingToSoundCloud, isUploadingToSubsplash]);
  return (
    <>
      <Box display="flex" alignItems="center">
        {showUploadButtons && (
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
        {showEdit && (
          <Tooltip title="Edit Sermon">
            <span>
              <Link href={`/admin/sermons/${sermon.id}?edit`}>
                <IconButton disabled={disableButtons} aria-label="edit sermon" style={{ color: 'lightblue' }}>
                  <EditIcon />
                </IconButton>
              </Link>
            </span>
          </Tooltip>
        )}
        {showUploadedTag && !user?.isAdmin() && <Chip label="Uploaded" color="success" />}

        {showRetry && <RetryProcessButton sermon={sermon} />}
        {showDelete && (
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
    </>
  );
};

export default SermonCardAdminControlsComponent;
