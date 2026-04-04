import { AspectRatio, ImageSizeType, ImageSizes, ImageType } from '../types/Image';

import ImageSelector from './ImageSelector';
import { KeyboardEvent, memo, useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import styles from '../styles/ImageViewer.module.css';
import { ISpeaker } from '../types/Speaker';
import Button from '@mui/material/Button';
import Cancel from '@mui/icons-material/Cancel';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';

const DynamicPopUp = dynamic(() => import('./PopUp'), { ssr: false });
interface propsType {
  images: ImageType[];
  newImageCallback: (image: ImageType | ImageSizeType) => void;
  speaker?: ISpeaker;
  vertical?: boolean;
  requiredTypes?: ImageSizeType[];
  showOptionalityChip?: boolean;
  renderHeaderForType?: (type: ImageSizeType, image?: ImageType) => React.ReactNode;
}

const ImageViewer = (props: propsType) => {
  const { newImageCallback } = props;
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const isTablet = useMediaQuery(theme.breakpoints.down('md'));
  const [selectedImage, setSelectedImage] = useState<ImageType>();
  const [newSelectedImage, setNewSelectedImage] = useState<ImageType>();
  const [imageSelectorPopup, setImageSelectorPopup] = useState<boolean>(false);
  const [popupTitle, setPopupTitle] = useState<string>('Select an Image');

  const confirmSelectedImage = useCallback(
    (image: ImageType) => {
      newImageCallback(image);
      setImageSelectorPopup(false);
    },
    [newImageCallback, setImageSelectorPopup]
  );

  const confirmSelectedImageWithSelection = useCallback(() => {
    if (!newSelectedImage) return;
    confirmSelectedImage(newSelectedImage);
  }, [newSelectedImage, confirmSelectedImage]);

  const handleKeyboardAction = useCallback((event: KeyboardEvent, action: () => void) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    action();
  }, []);

  const requiredTypes = props.requiredTypes ?? [];
  const showOptionalityChip = props.showOptionalityChip ?? true;
  const isRequiredType = (type: ImageSizeType): boolean => requiredTypes.includes(type);

  return (
    <>
      <div
        style={{
          height: '100%',
          display: 'grid',
          gridTemplateColumns: props.vertical ? '1fr' : isMobile ? '1fr' : isTablet ? 'repeat(2, minmax(0, 1fr))' : 'repeat(3, minmax(0, 1fr))',
          gap: isMobile ? '16px' : '10px',
          alignItems: 'center',
          justifyItems: 'center',
        }}
      >
        {ImageSizes.map((type, i) => {
          const image: ImageType | undefined = props.images.find((image) => image.type === type);
          const header = props.renderHeaderForType?.(type, image);
          const shouldPrioritizeImage = props.vertical && i === 0;
          return image ? (
            <div key={`${image.id}-image`} style={{ width: '100%' }}>
              {header && <div style={{ marginBottom: '8px' }}>{header}</div>}
              <div id={`${image.id}-image`} className={styles.imageHover}>
                <div
                  className={styles.imageContainer}
                  style={{
                    aspectRatio: AspectRatio[type],
                    backgroundColor: 'transparent',
                    overflow: 'visible',
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`Change ${type} image`}
                  onClick={() => {
                    setImageSelectorPopup(true);
                    setSelectedImage(image);
                    setNewSelectedImage(image);
                  }}
                  onKeyDown={(event) =>
                    handleKeyboardAction(event, () => {
                      setImageSelectorPopup(true);
                      setSelectedImage(image);
                      setNewSelectedImage(image);
                    })
                  }
                  >
                  <div
                    style={{
                      borderRadius: '5px',
                      overflow: 'hidden',
                      position: 'absolute',
                      inset: 0,
                      backgroundColor: image.averageColorHex || 'var(--placeholder-bg, #2d323b)',
                    }}
                  >
                    <Image
                      src={image.downloadLink}
                      alt={image.name}
                      loading={shouldPrioritizeImage ? 'eager' : 'lazy'}
                      fetchPriority={shouldPrioritizeImage ? 'high' : undefined}
                      sizes={
                        props.vertical
                          ? '(max-width: 600px) min(300px, calc(100vw - 32px)), 300px'
                          : '(max-width: 600px) 100vw, (max-width: 900px) 50vw, 33vw'
                      }
                      style={{
                        objectFit: 'contain',
                      }}
                      fill
                    />
                  </div>
                </div>
                <h3 className={styles.imageCover}>Change Image</h3>
                <div className={styles.removeImage} onMouseOver={(e) => e.preventDefault()}>
                  <Tooltip title="Remove Image" placement="right-start">
                    <IconButton
                      size="small"
                      aria-label={`Remove ${type} image`}
                      onClick={() => {
                        newImageCallback(image.type);
                        setSelectedImage(undefined);
                        setNewSelectedImage(undefined);
                      }}
                    >
                      <Cancel sx={{ color: 'red' }} />
                    </IconButton>
                  </Tooltip>
                </div>
              </div>
              <div
                key={`${image.id}-label`}
                id={`${image.id}-label`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gridRowStart: props.vertical ? 'unset' : 2,
                  alignItems: 'center',
                }}
              >
                <h4 style={{ margin: 0 }}>{image.name}</h4>
                <span>{`${image.type} ${image.width}x${image.height}`}</span>
              </div>
            </div>
          ) : (
            <div key={i} style={{ width: '100%' }}>
              {header && <div style={{ marginBottom: '8px' }}>{header}</div>}
              <div className={styles.imageHover}>
              <div
                style={{
                  display: 'flex',
                  borderRadius: '8px',
                  overflow: 'visible',
                  position: 'relative',
                  width: '100%',
                  justifyContent: 'center',
                  alignItems: 'center',
                  backgroundColor: 'var(--placeholder-bg, #2d323b)',
                  aspectRatio: AspectRatio[type],
                  border: '2px dashed var(--border-color, rgba(255,255,255,0.2))',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease-in-out',
                  borderColor: isRequiredType(type)
                    ? 'rgba(245, 158, 11, 0.8)'
                    : 'var(--border-color, rgba(255,255,255,0.2))',
                }}
                role="button"
                tabIndex={0}
                aria-label={`Add ${type} image`}
                onClick={() => {
                  setImageSelectorPopup(true);
                  setSelectedImage({ type } as ImageType);
                }}
                onKeyDown={(event) =>
                  handleKeyboardAction(event, () => {
                    setImageSelectorPopup(true);
                    setSelectedImage({ type } as ImageType);
                  })
                }
                >
                {showOptionalityChip && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 12,
                      transform: 'translateY(-50%)',
                      padding: '2px 8px',
                      borderRadius: '999px',
                      backgroundColor: isRequiredType(type)
                        ? 'rgba(245, 158, 11, 0.92)'
                        : 'rgba(15, 23, 42, 0.72)',
                      color: isRequiredType(type) ? '#111827' : '#e2e8f0',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      letterSpacing: '0.01em',
                    }}
                  >
                    {isRequiredType(type) ? 'Required' : 'Optional'}
                  </div>
                )}
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: '8px',
                    overflow: 'hidden',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ color: 'var(--text-secondary, #94a3b8)', fontSize: '0.875rem' }}>
                    Add {type} image +
                  </span>
                </div>
              </div>
              </div>
            </div>
          );
        })}
      </div>
      {selectedImage && (
        <DynamicPopUp
          title={popupTitle}
          open={imageSelectorPopup}
          setOpen={setImageSelectorPopup}
          dialogProps={{ fullWidth: true, maxWidth: 'lg' }}
          button={
            <Button
              variant="contained"
              color="primary"
              disabled={selectedImage.id === newSelectedImage?.id}
              onClick={confirmSelectedImageWithSelection}
            >
              Confirm
            </Button>
          }
        >
          <ImageSelector
            selectedSpeaker={props.speaker}
            selectedImageFromSpeakerDetails={selectedImage}
            newSelectedImage={newSelectedImage}
            setNewSelectedImage={setNewSelectedImage}
            confirmSelecedImage={confirmSelectedImage}
            setPopupTitle={setPopupTitle}
          />
        </DynamicPopUp>
      )}
    </>
  );
};

export default memo(ImageViewer);
