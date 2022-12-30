import { AspectRatio, ImageSizeType, ImageSizes, ImageType } from '../types/Image';
import { sanitize } from 'dompurify';
import ImageSelector from './ImageSelector';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import styles from '../styles/ImageViewer.module.css';
import { ISpeaker } from '../types/Speaker';
import Button from '@mui/material/Button';
import Cancel from '@mui/icons-material/Cancel';
import Tooltip from '@mui/material/Tooltip';

const DynamicPopUp = dynamic(() => import('./PopUp'), { ssr: false });
interface propsType {
  images: ImageType[];
  newImageCallback: (image: ImageType | ImageSizeType) => void;
  speaker?: ISpeaker;
  vertical?: boolean;
}

function ImageViewer({ images, newImageCallback, speaker, vertical }: propsType) {
  const [selectedImage, setSelectedImage] = useState<ImageType>();
  const [newSelectedImage, setNewSelectedImage] = useState<ImageType>();
  const [imageSelectorPopup, setImageSelectorPopup] = useState<boolean>(false);
  return (
    <>
      <div
        style={{
          height: '100%',
          display: 'grid',
          gridTemplateColumns: vertical ? '1fr' : 'repeat(3, 1fr)',
          gap: '10px',
          alignItems: 'center',
          justifyItems: 'center',
        }}
      >
        {ImageSizes.map((type, i) => {
          const image: ImageType | undefined = images.find((image) => image.type === type);
          return image ? (
            <>
              <div key={`${image.id}-image`} id={`${image.id}-image`} className={styles.imageHover}>
                <div
                  className={styles.imageContainer}
                  style={{
                    aspectRatio: AspectRatio[type],
                    backgroundColor: image.averageColorHex || '#f3f1f1',
                  }}
                  onClick={() => {
                    setImageSelectorPopup(true);
                    setSelectedImage(image);
                    setNewSelectedImage(image);
                  }}
                >
                  <Image
                    src={`${sanitize(image.downloadLink)}`}
                    alt={image.name}
                    style={{ borderRadius: '5px' }}
                    layout="fill"
                    objectFit="contain"
                  />
                </div>
                <h3 className={styles.imageCover}>Change Image</h3>
                <div className={styles.removeImage} onMouseOver={(e) => e.preventDefault()}>
                  <Tooltip title="Remove Image" placement="right-start">
                    <Cancel
                      sx={{ color: 'red' }}
                      onClick={() => {
                        newImageCallback(image.type);
                        setSelectedImage(undefined);
                        setNewSelectedImage(undefined);
                      }}
                    />
                  </Tooltip>
                </div>
              </div>
              <div
                key={`${image.id}-label`}
                id={`${image.id}-label`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gridRowStart: vertical ? 'unset' : 2,
                  alignItems: 'center',
                }}
              >
                <h4 style={{ margin: 0 }}>{image.name}</h4>
                <span>{`${image.type} ${image.width}x${image.height}`}</span>
              </div>
            </>
          ) : (
            <div key={i} className={styles.imageHover}>
              <div
                style={{
                  display: 'flex',
                  borderRadius: '5px',
                  overflow: 'hidden',
                  position: 'relative',
                  width: '100%',
                  justifyContent: 'center',
                  alignItems: 'center',
                  backgroundColor: '#f3f1f1',
                  aspectRatio: AspectRatio[type],
                }}
                onClick={() => {
                  setImageSelectorPopup(true);
                  setSelectedImage({ type } as ImageType);
                }}
              >
                <span>Add image +</span>
              </div>
            </div>
          );
        })}
      </div>
      {selectedImage && (
        <DynamicPopUp
          title="Select an Image"
          open={imageSelectorPopup}
          setOpen={setImageSelectorPopup}
          dialogProps={{ fullWidth: true, maxWidth: 'lg' }}
          button={
            <Button
              variant="contained"
              color="primary"
              disabled={selectedImage.id === newSelectedImage?.id}
              onClick={() => {
                newSelectedImage && newImageCallback(newSelectedImage);
                setImageSelectorPopup(false);
              }}
            >
              Set Speaker Image
            </Button>
          }
        >
          <ImageSelector
            selectedSpeaker={speaker}
            selectedImageFromSpeakerDetails={selectedImage}
            newSelectedImage={newSelectedImage}
            setNewSelectedImage={setNewSelectedImage}
          />
        </DynamicPopUp>
      )}
    </>
  );
}

export default ImageViewer;
