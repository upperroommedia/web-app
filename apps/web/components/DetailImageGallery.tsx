import { memo, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import Image from 'next/image';
import { AspectRatio, ImageSizes, ImageType } from '../types/Image';

interface DetailImageGalleryProps {
  images?: ImageType[];
  altName: string;
}

const DetailImageGallery = ({ images = [], altName }: DetailImageGalleryProps) => {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [selectedImage, setSelectedImage] = useState<ImageType | null>(null);

  const populatedImages = useMemo(
    () =>
      ImageSizes
        .map((type) => images.find((image) => image.type === type && Boolean(image.downloadLink)))
        .filter((image): image is ImageType => Boolean(image)),
    [images]
  );

  if (populatedImages.length === 0) {
    return null;
  }

  return (
    <>
      <Box
        sx={{
          width: '100%',
          maxWidth: '100%',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: { xs: 'stretch', sm: 'flex-end' },
          gap: 1.25,
          flexShrink: 0,
        }}
      >
        {populatedImages.map((image) => (
          <Box
            key={image.id}
            sx={{
              width: { xs: '100%', sm: 'min(240px, calc(50% - 5px))', md: 'min(240px, calc(33.333% - 7px))' },
              maxWidth: '100%',
            }}
          >
            <Box
              role="button"
              tabIndex={0}
              onClick={() => setSelectedImage(image)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelectedImage(image);
                }
              }}
              sx={{
                position: 'relative',
                width: '100%',
                aspectRatio: `${AspectRatio[image.type]}`,
                borderRadius: 2,
                overflow: 'hidden',
                bgcolor: image.averageColorHex || 'action.hover',
                boxShadow: 3,
                cursor: 'zoom-in',
              }}
            >
              <Image
                src={image.downloadLink}
                alt={`${altName} ${image.type}`}
                fill
                sizes="(max-width: 600px) calc(100vw - 64px), 240px"
                style={{ objectFit: 'cover' }}
              />
            </Box>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                mt: 0.5,
                display: 'block',
                textTransform: 'capitalize',
              }}
            >
              {image.type}
            </Typography>
          </Box>
        ))}
      </Box>

      <Dialog
        open={Boolean(selectedImage)}
        onClose={() => setSelectedImage(null)}
        fullScreen={fullScreen}
        maxWidth="xl"
        sx={{
          '& .MuiDialog-container': {
            alignItems: 'center',
          },
        }}
        PaperProps={{
          sx: {
            bgcolor: 'transparent',
            boxShadow: 'none',
            overflow: 'visible',
            width: 'auto',
            height: 'auto',
            maxWidth: 'none',
            maxHeight: 'none',
          },
        }}
      >
        {selectedImage && (
          <Box
            sx={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 'fit-content',
              height: 'fit-content',
              maxWidth: { xs: '100vw', sm: '92vw' },
              maxHeight: { xs: '100vh', sm: '90vh' },
            }}
          >
            <IconButton
              onClick={() => setSelectedImage(null)}
              sx={{
                position: 'absolute',
                top: 12,
                right: 12,
                zIndex: 1,
                color: 'common.white',
                bgcolor: 'rgba(15, 23, 42, 0.55)',
                '&:hover': {
                  bgcolor: 'rgba(15, 23, 42, 0.75)',
                },
              }}
            >
              <CloseIcon />
            </IconButton>
            <Image
              src={selectedImage.downloadLink}
              alt={`${altName} ${selectedImage.type}`}
              width={selectedImage.width || 1600}
              height={selectedImage.height || Math.round((selectedImage.width || 1600) / AspectRatio[selectedImage.type])}
              sizes={fullScreen ? '100vw' : '92vw'}
              style={{
                width: 'auto',
                height: 'auto',
                maxWidth: '100%',
                maxHeight: fullScreen ? '100vh' : '90vh',
                display: 'block',
              }}
            />
          </Box>
        )}
      </Dialog>
    </>
  );
};

export default memo(DetailImageGallery);
