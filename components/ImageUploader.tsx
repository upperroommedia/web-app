import Button from '@mui/material/Button';
import Slider from '@mui/material/Slider';
import Typography from '@mui/material/Typography';
import { useState, useCallback } from 'react';
import getCroppedImg, { CroppedImageData } from '../utils/cropImage';

import Cropper from 'react-easy-crop';
import styles from '../styles/Cropper.module.css';
import { ImageSizeType } from '../types/Image';
import OutlinedInput from '@mui/material/OutlinedInput';
import InputAdornment from '@mui/material/InputAdornment';
import dynamic from 'next/dynamic';
const DynamicPopUp = dynamic(() => import('./PopUp'), { ssr: false });
interface Props {
  imgSrc?: string;
  onFinish: (croppedImageData: CroppedImageData) => void;
  type: ImageSizeType;
  title: string;
  setTitle: (newTitle: string) => void;
}

const typeToAspectRatio = {
  square: 1,
  wide: 16 / 9,
  banner: 480 / 173,
};

const ImageUploader = (props: Props) => {
  const [imgSrc, setImgSrc] = useState(props.imgSrc);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);

  const onCropComplete = useCallback((croppedArea, croppedAreaPixels) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  function onSelectFile(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      setCrop({ x: 0, y: 0 }); // Makes crop preview update between images.
      const reader = new FileReader();
      reader.addEventListener('load', () => setImgSrc(reader.result?.toString() || ''));
      reader.readAsDataURL(e.target.files[0]);
    }
  }

  // const getImageSrc = async (url: string) => {
  //   if (url.includes('https://core.subsplash.com')) {
  //     const getImage = createFunction<GetImageInputType, GetImageOutputType>('getimage');
  //     try {
  //       const imageResponse = await getImage({ url });
  //       const imageBuffer = Buffer.from(imageResponse.buffer.data);
  //       url = URL.createObjectURL(new Blob([imageBuffer], { type: 'image/jpeg' }));
  //     } catch (error) {
  //       // TODO: Fix this better since the error is HttpsError from firebase-functions not Error
  //       const httpError = error as Error;
  //       alert(httpError.message);
  //     }
  //   }
  //   return url;
  // };
  if (!imgSrc) {
    return <input type="file" accept="image/*" onChange={onSelectFile} />;
  }
  return (
    <DynamicPopUp
      title="Select an Image"
      open={imgSrc !== undefined}
      setOpen={(bool) => {
        if (!bool) {
          setImgSrc(undefined);
        }
      }}
      dialogProps={{ fullWidth: true, maxWidth: 'lg' }}
      button={
        <Button
          onClick={async () => {
            if (imgSrc && croppedAreaPixels) {
              const croppedImage = await getCroppedImg(imgSrc, croppedAreaPixels, rotation, props.type);
              croppedImage && props.onFinish(croppedImage);
            }
          }}
          variant="contained"
          color="primary"
          classes={{ root: styles.cropButton }}
        >
          Crop
        </Button>
      }
    >
      <div>
        <div className={styles.cropContainer}>
          (
          <Cropper
            image={imgSrc}
            crop={crop}
            rotation={rotation}
            zoom={zoom}
            aspect={typeToAspectRatio[props.type]}
            onCropChange={setCrop}
            onRotationChange={setRotation}
            onCropComplete={onCropComplete}
            onZoomChange={setZoom}
          />
          )
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
            <OutlinedInput
              id="outlined-adornment-title"
              endAdornment={<InputAdornment position="end">{`-${props.type}`}</InputAdornment>}
              aria-describedby="outlined-title-helper-text"
              inputProps={{
                'aria-label': 'title',
              }}
              value={props.title}
              sx={{ width: '100%' }}
              onChange={(e) => {
                props.setTitle(e.target.value);
              }}
            />
          </div>
        </div>
      </div>
    </DynamicPopUp>
  );
};

export default ImageUploader;
