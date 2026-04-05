import { FunctionComponent } from 'react';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import SermonPublishPanel from './SermonPublishPanel';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import { Sermon } from '../types/SermonTypes';
import type { DestinationActivityState } from '../utils/sermonPublishActions';

interface ManagePublishingPopupProps {
  sermon: Sermon;
  open: boolean;
  onClose: () => void;
  onUpdate?: () => void;
  onBusyStateChange?: (activity: DestinationActivityState) => void;
}

const ManagePublishingPopup: FunctionComponent<ManagePublishingPopupProps> = ({
  sermon,
  open,
  onClose,
  onUpdate,
  onBusyStateChange,
}) => {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{ sx: { borderRadius: 2 } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <AvatarWithDefaultImage
            altName={sermon.title}
            image={sermon.images?.find((image) => image.type === 'square')}
            width={48}
            height={48}
            borderRadius={8}
          />
          <Box>
            <Typography variant="h6" fontWeight={600}>Publish Sermon</Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {sermon.title}
            </Typography>
          </Box>
        </Box>
        <IconButton onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <Divider />

      <DialogContent sx={{ p: 3 }}>
        <SermonPublishPanel
          sermon={sermon}
          onUpdate={onUpdate}
          onBusyStateChange={onBusyStateChange}
          initialAdvancedOpen={false}
        />
      </DialogContent>
    </Dialog>
  );
};

export default ManagePublishingPopup;
