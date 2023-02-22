import Image from 'next/image';

import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import Box from '@mui/system/Box';
import PublishIcon from '@mui/icons-material/Publish';
import UnpublishedIcon from '@mui/icons-material/Unpublished';
import Tooltip from '@mui/material/Tooltip';
import SoundCloudLogo from '../public/soundcloud.png';

import PopUp from './PopUp';
import EditSermonForm from './EditSermonForm';
import DeleteEntityPopup from './DeleteEntityPopup';
import { Dispatch, FunctionComponent, SetStateAction, useState } from 'react';
import { Sermon, uploadStatus } from '../types/SermonTypes';

interface SermonCardAdminControlsComponentProps {
  sermon: Sermon;
  isUploadingToSubsplash: boolean;
  isUploadingToSoundCloud: boolean;
  uploadToSubsplashPopup: boolean;
  autoPublish: boolean;
  setUploadToSubsplashPopup: (boolean: boolean) => void;
  setAutoPublish: Dispatch<SetStateAction<boolean>>;
  handleDelete: () => Promise<void>;
  uploadToSoundCloud: () => Promise<void>;
  uploadToSubsplash: () => Promise<void>;
  deleteFromSoundCloud: () => Promise<void>;
  deleteFromSubsplash: () => Promise<void>;
}

const SermonCardAdminControlsComponent: FunctionComponent<SermonCardAdminControlsComponentProps> = ({
  sermon,
  isUploadingToSoundCloud,
  isUploadingToSubsplash,
  uploadToSubsplashPopup,
  autoPublish,
  setUploadToSubsplashPopup,
  setAutoPublish,
  handleDelete,
  uploadToSoundCloud,
  uploadToSubsplash,
  deleteFromSoundCloud,
  deleteFromSubsplash,
}: SermonCardAdminControlsComponentProps) => {
  const [deleteConfirmationPopup, setDeleteConfirmationPopup] = useState<boolean>(false);
  const [editFormPopup, setEditFormPopup] = useState<boolean>(false);

  return (
    <>
      <Box display="flex">
        {isUploadingToSoundCloud ? (
          <CircularProgress size={24} />
        ) : sermon.status.soundCloud === uploadStatus.UPLOADED ? (
          <Tooltip title="Remove From Soundcloud">
            <IconButton aria-label="Upload to Subsplash" onClick={deleteFromSoundCloud}>
              <UnpublishedIcon style={{ color: 'orangered' }} />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title="Upload to Soundcloud">
            <IconButton onClick={() => uploadToSoundCloud()}>
              <Image src={SoundCloudLogo} alt="Soundcloud Logo" width={24} height={24} />
            </IconButton>
          </Tooltip>
        )}
        {isUploadingToSubsplash ? (
          <CircularProgress size={24} />
        ) : sermon.status.subsplash === uploadStatus.UPLOADED ? (
          <Tooltip title="Remove From Subsplash">
            <IconButton aria-label="Upload to Subsplash" onClick={deleteFromSubsplash}>
              <UnpublishedIcon style={{ color: 'orangered' }} />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title="Upload to Subsplash">
            <IconButton
              aria-label="Upload to Subsplash"
              style={{ color: 'lightgreen' }}
              onClick={() => {
                setUploadToSubsplashPopup(true);
              }}
            >
              <PublishIcon />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Edit Sermon">
          <IconButton aria-label="edit sermon" style={{ color: 'lightblue' }} onClick={() => setEditFormPopup(true)}>
            <EditIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Delete Sermon From All Systems">
          <IconButton
            aria-label="delete sermon"
            style={{ color: 'red' }}
            onClick={() => setDeleteConfirmationPopup(true)}
          >
            <DeleteIcon />
          </IconButton>
        </Tooltip>
      </Box>
      <PopUp
        title={'Upload Sermon to Supsplash?'}
        open={uploadToSubsplashPopup}
        setOpen={() => setUploadToSubsplashPopup(false)}
        button={
          <Button aria-label="Confirm Upload to Subsplash" onClick={uploadToSubsplash}>
            {isUploadingToSoundCloud ? <CircularProgress /> : 'Upload'}
          </Button>
        }
      >
        <Box>
          <Typography variant="h6">Title: {sermon.title}</Typography>
          <Box display="flex" alignItems={'center'} onClick={() => setAutoPublish((previousValue) => !previousValue)}>
            <Checkbox checked={autoPublish} />
            <Typography>Auto publish when upload is complete</Typography>
          </Box>
        </Box>
      </PopUp>
      <DeleteEntityPopup
        entityBeingDeleten="sermon"
        handleDelete={handleDelete}
        deleteConfirmationPopup={deleteConfirmationPopup}
        setDeleteConfirmationPopup={setDeleteConfirmationPopup}
      />
      <EditSermonForm open={editFormPopup} setOpen={() => setEditFormPopup(false)} sermon={sermon} />
    </>
  );
};

export default SermonCardAdminControlsComponent;
