import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { Sermon, uploadStatus } from '../types/SermonTypes';
import UnpublishedIcon from '@mui/icons-material/Unpublished';
import SoundCloudLogo from '../public/soundcloud.png';
import { isDevelopment } from '../firebase/firebase';
import Image from 'next/image';
import PopUp from './PopUp';
import { useCallback, useState } from 'react';
import Button from '@mui/material/Button';

interface ManageSoundcloudButtonProps {
  sermon: Sermon;
  isUploadingToSoundCloud: boolean;
  disableButtons: boolean;
  uploadToSoundCloud: () => Promise<void>;
  deleteFromSoundCloud: () => Promise<void>;
}

const ManageSoundcloudButton = ({
  sermon,
  isUploadingToSoundCloud,
  disableButtons,
  uploadToSoundCloud,
  deleteFromSoundCloud,
}: ManageSoundcloudButtonProps) => {
  const [deleteConfirmationPopup, setDeleteConfirmationPopup] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const handleDeleteConfirmationPopup = useCallback(() => {
    setDeleteConfirmationPopup(true);
  }, [setDeleteConfirmationPopup]);
  return (
    <>
      {isUploadingToSoundCloud ? (
        <CircularProgress size={24} sx={{ margin: 1 }} />
      ) : sermon.status.soundCloud === uploadStatus.UPLOADED ? (
        <Tooltip title="Remove From SoundCloud">
          <span>
            <IconButton
              aria-label="Remove from SoundCloud"
              disabled={disableButtons}
              onClick={handleDeleteConfirmationPopup}
            >
              <UnpublishedIcon style={{ color: 'orangered' }} />
            </IconButton>
          </span>
        </Tooltip>
      ) : (
        <Tooltip title={isDevelopment ? 'Cannot upload to SoundCloud from dev environment' : 'Upload to SoundCloud'}>
          <span>
            <IconButton disabled={disableButtons || isDevelopment} onClick={() => uploadToSoundCloud()}>
              <Image src={SoundCloudLogo} alt="SoundCloud Logo" width={24} height={24} />
            </IconButton>
          </span>
        </Tooltip>
      )}
      <PopUp
        title={'Are you sure you want remove this sermon from SoundCloud?'}
        open={deleteConfirmationPopup}
        setOpen={setDeleteConfirmationPopup}
        disabled={isDeleting}
        dialogActionsProps={{ style: { justifyContent: 'space-between' } }}
        button={
          <Button
            aria-label={`confirm remove from SoundCloud`}
            onClick={async () => {
              setIsDeleting(true);
              await deleteFromSoundCloud();
              setDeleteConfirmationPopup(false);
              setIsDeleting(false);
            }}
            color="error"
            variant="contained"
            disabled={isDeleting}
          >
            {isDeleting ? <CircularProgress /> : 'Remove from SoundCloud'}
          </Button>
        }
      >
        <></>
      </PopUp>
    </>
  );
};

export default ManageSoundcloudButton;
