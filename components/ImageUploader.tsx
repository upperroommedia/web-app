import Button from '@mui/material/Button';
import Slider from '@mui/material/Slider';
import Typography from '@mui/material/Typography';
import { useState, useCallback } from 'react';
import getCroppedImg, { CroppedImageData } from '../utils/cropImage';

import Cropper, { Area } from 'react-easy-crop';
import styles from '../styles/Cropper.module.css';
import { ImageSizeType } from '../types/Image';
import OutlinedInput from '@mui/material/OutlinedInput';
import InputAdornment from '@mui/material/InputAdornment';
import dynamic from 'next/dynamic';

const DynamicPopUp = dynamic(() => import('./PopUp'), { ssr: false });
interface Props {
  imgSrc?: string;
  onFinish: (croppedImageData: CroppedImageData, name: string) => void;
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
  const [imageType, setImageType] = useState('');
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area>();

  const onCropComplete = useCallback((croppedArea: Area, croppedAreaPixels: Area) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  function onSelectFile(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      setCrop({ x: 0, y: 0 }); // Makes crop preview update between images.
      const reader = new FileReader();
      reader.addEventListener('load', () => setImgSrc(reader.result?.toString() || ''));
      reader.readAsDataURL(e.target.files[0]);
      props.title === '' && props.setTitle(e.target.files[0].name.split('.')[0]);
      setImageType(e.target.files[0].type.split('/').pop()!);
    }
  }

  if (!imgSrc) {
    return <input type="file" accept="image/*" onChange={onSelectFile} />;
  }
  return (
    <DynamicPopUp
      title="Crop Image"
      open={true}
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
              if (croppedImage) {
                props.onFinish(croppedImage, `${props.title}-${props.type}.${imageType}`);
                setImgSrc(undefined);
              }
            }
          }}
          variant="contained"
          color="primary"
          classes={{ root: styles.cropButton }}
          disabled={props.title === ''}
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
            objectFit="auto-cover"
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
              endAdornment={<InputAdornment position="end">{`-${props.type}.${imageType}`}</InputAdornment>}
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
