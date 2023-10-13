import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { Sermon, uploadStatus } from '../types/SermonTypes';
import UnpublishedIcon from '@mui/icons-material/Unpublished';
import SoundCloudLogo from '../public/soundcloud.png';
import { isDevelopment } from '../firebase/firebase';
import Image from 'next/image';

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
  return (
    <>
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
    </>
  );
};

export default ManageSoundcloudButton;
