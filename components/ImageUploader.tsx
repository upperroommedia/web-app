import Button from '@mui/material/Button';
import Slider from '@mui/material/Slider';
import Typography from '@mui/material/Typography';
import { useState, useEffect, useCallback } from 'react';
import getCroppedImg from '../utils/cropImage';

import Cropper from 'react-easy-crop';
import { GetImageInputType, GetImageOutputType } from '../functions/src/getImage';
import { createFunction } from '../utils/createFunction';
import styles from '../styles/Cropper.module.css';

interface Props {
  imgSrc: string;
  updateSermonImage: (imgSrc: string) => void;
}

const ImageUploader = (props: Props) => {
  const [imgSrc, setImgSrc] = useState('');
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);

  const onCropComplete = useCallback((croppedArea, croppedAreaPixels) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  useEffect(() => {
    const g = async () => {
      if (props.imgSrc) setImgSrc(await getImageSrc(props.imgSrc));
    };
    g();
  }, []);

  function onSelectFile(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      setCrop({ x: 0, y: 0 }); // Makes crop preview update between images.
      const reader = new FileReader();
      reader.addEventListener('load', () => setImgSrc(reader.result?.toString() || ''));
      reader.readAsDataURL(e.target.files[0]);
    }
  }

  const getImageSrc = async (url: string) => {
    if (url.includes('https://core.subsplash.com')) {
      const getImage = createFunction<GetImageInputType, GetImageOutputType>('getimage');
      try {
        const imageResponse = await getImage({ url });
        const imageBuffer = Buffer.from(imageResponse.buffer.data);
        url = URL.createObjectURL(new Blob([imageBuffer], { type: 'image/jpeg' }));
      } catch (error) {
        // TODO: Handle error
        if (error && error.message) {
          alert(error.message);
        }
      }
    }
    return url;
  };

  return (
    <div>
      <input type="file" accept="image/*" onChange={onSelectFile} />
      <div className={styles.cropContainer}>
        {imgSrc && (
          <Cropper
            image={imgSrc}
            crop={crop}
            rotation={rotation}
            zoom={zoom}
            aspect={1}
            onCropChange={setCrop}
            onRotationChange={setRotation}
            onCropComplete={onCropComplete}
            onZoomChange={setZoom}
          />
        )}
      </div>
      <div className={styles.controls}>
        <div className={styles.sliderContainer}>
          <Typography variant="overline" classes={{ root: styles.sliderLabel }}>
            Zoom
          </Typography>
          <Slider
            value={zoom}
            min={1}
            max={3}
            step={0.1}
            aria-labelledby="Zoom"
            classes={{ root: styles.slider }}
            onChange={(e, zoom) => {
              if (typeof zoom === 'number') {
                setZoom(zoom);
              }
            }}
          />
        </div>
        <div className={styles.sliderContainer}>
          <Typography variant="overline" classes={{ root: styles.sliderLabel }}>
            Rotation
          </Typography>
          <Slider
            value={rotation}
            min={0}
            max={360}
            step={1}
            aria-labelledby="Rotation"
            classes={{ root: styles.slider }}
            onChange={(e, rotation) => {
              if (typeof rotation === 'number') {
                setRotation(rotation);
              }
            }}
          />
        </div>
        <Button
          onClick={async () => {
            if (imgSrc && croppedAreaPixels) {
              const croppedImage = await getCroppedImg(imgSrc, croppedAreaPixels, rotation);
              props.updateSermonImage(croppedImage);
              // download cropped image
              // const link = document.createElement('a');
              // link.href = croppedImage;
              // link.setAttribute('download', 'image.jpg');
              // document.body.appendChild(link);
              // link.click();
            }
          }}
          variant="contained"
          color="primary"
          classes={{ root: styles.cropButton }}
        >
          Crop
        </Button>
      </div>
    </div>
  );
};

export default ImageUploader;
