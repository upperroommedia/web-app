import { AspectRatio, ImageSizes, ImageType } from '../types/Image';
import { sanitize } from 'dompurify';
import { ISpeaker } from '../types/Speaker';
import ImageSelector from './ImageSelector';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import styles from '../styles/ImageViewer.module.css';

const DynamicPopUp = dynamic(() => import('./PopUp'), { ssr: false });
interface propsType {
  speaker?: ISpeaker;
  newImageCallback: (image: ImageType) => void;
  vertical?: boolean;
}

function ImageViewer({ speaker, newImageCallback, vertical }: propsType) {
  const [selectedImage, setSelectedImage] = useState<ImageType>();
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
          const image: ImageType | undefined = speaker?.images?.find((image) => image.type === type);
          return image ? (
            <>
              <div className={styles.imageHover}>
                <div
                  className={styles.imageContainer}
                  key={image.id}
                  style={{
                    aspectRatio: AspectRatio[type],
                    backgroundColor: image.averageColorHex || '#f3f1f1',
                  }}
                  onClick={() => {
                    setImageSelectorPopup(true);
                    setSelectedImage(image);
                  }}
                >
                  <Image
                    src={`${sanitize(image.downloadLink)}`}
                    alt={image.name}
                    style={{ position: 'relative', borderRadius: '5px' }}
                    layout="fill"
                    objectFit="contain"
                  />
                </div>
                <h3 className={styles.imageCover}>Change Image</h3>
              </div>
              <div
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
            <div className={styles.imageHover}>
              <div
                key={i}
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
        >
          <ImageSelector
            selectedSpeaker={speaker}
            selectedImageFromSpeakerDetails={selectedImage}
            setImageSelectorPopup={setImageSelectorPopup}
            newImageCallback={newImageCallback}
          />
        </DynamicPopUp>
      )}
    </>
  );
}

export default ImageViewer;
