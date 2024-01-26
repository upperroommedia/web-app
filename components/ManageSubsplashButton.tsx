import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CountOfUploadsCircularProgress from './CountOfUploadsCircularProgress';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';

interface ManageSubsplashButtonProps {
  sermonNumberOfListsUploadedTo: number | undefined;
  sermonNumberOfLists: number | undefined;
  isUploadingToSubsplash: boolean;
  disableButtons: boolean;
  setManageUploadsPopup: (boolean: boolean) => void;
}

const ManageSubsplashButton = ({
  sermonNumberOfListsUploadedTo,
  sermonNumberOfLists,
  isUploadingToSubsplash,
  disableButtons,
  setManageUploadsPopup,
}: ManageSubsplashButtonProps) => {
  return (
    <>
      {isUploadingToSubsplash ? (
        <CircularProgress size={24} sx={{ margin: 1 }} />
      ) : !sermonNumberOfLists ? (
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
              <CountOfUploadsCircularProgress
                sermonNumberOfListsUploadedTo={sermonNumberOfListsUploadedTo}
                sermonNumberOfLists={sermonNumberOfLists}
                size={30}
              />
            </IconButton>
          </span>
        </Tooltip>
      )}
    </>
  );
};

export default ManageSubsplashButton;
