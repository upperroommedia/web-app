import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import getCroppedImg, {
  CroppedImageData,
  resolveImageBackgroundColorHex,
} from '../utils/cropImage';

import Cropper, { Area, MediaSize, Size } from 'react-easy-crop';
import styles from '../styles/Cropper.module.css';
import { ImageSizeType } from '../types/Image';
import OutlinedInput from '@mui/material/OutlinedInput';
import InputAdornment from '@mui/material/InputAdornment';
import dynamic from 'next/dynamic';
import ColorizeIcon from '@mui/icons-material/Colorize';

const DynamicPopUp = dynamic(() => import('./PopUp'), { ssr: false });

const inferImageExtension = (value?: string): string => {
  if (!value) {
    return 'jpg';
  }

  const normalizedValue = value.split('?')[0] ?? value;
  const extension = normalizedValue.split('.').pop()?.toLowerCase();
  return extension && extension.length > 0 ? extension : 'jpg';
};

interface Props {
  imgSrc?: string;
  onFinish: (croppedImageData: CroppedImageData, name: string) => Promise<void> | void;
  type: ImageSizeType;
  title: string;
  setTitle: (newTitle: string) => void;
  sourceFileName?: string;
  onCancel?: () => void;
}

const typeToAspectRatio = {
  square: 1,
  wide: 16 / 9,
  banner: 480 / 173,
};

type BackgroundFillMode = 'auto' | 'custom';

type EyeDropperResult = { sRGBHex: string };

interface EyeDropperInstance {
  open: () => Promise<EyeDropperResult>;
}

interface WindowWithEyeDropper extends Window {
  EyeDropper?: new () => EyeDropperInstance;
}

const getRadianAngle = (degreeValue: number): number => (degreeValue * Math.PI) / 180;

const rotateSize = (width: number, height: number, rotation: number): Size => {
  const rotRad = getRadianAngle(rotation);
  return {
    width: Math.abs(Math.cos(rotRad) * width) + Math.abs(Math.sin(rotRad) * height),
    height: Math.abs(Math.sin(rotRad) * width) + Math.abs(Math.cos(rotRad) * height),
  };
};

const ImageUploader = (props: Props) => {
  const [imgSrc, setImgSrc] = useState(props.imgSrc);
  const [imageType, setImageType] = useState(() => inferImageExtension(props.sourceFileName ?? props.imgSrc));
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [minZoom, setMinZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area>();
  const [autoBackgroundColorHex, setAutoBackgroundColorHex] = useState('#9fccb9');
  const [backgroundFillMode, setBackgroundFillMode] = useState<BackgroundFillMode>('auto');
  const [customBackgroundColorHex, setCustomBackgroundColorHex] = useState('#000000');
  const [isCropping, setIsCropping] = useState(false);
  const [isPickingColor, setIsPickingColor] = useState(false);
  const [mediaSize, setMediaSize] = useState<MediaSize | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewResizeObserverRef = useRef<ResizeObserver | null>(null);
  const [previewContainerSize, setPreviewContainerSize] = useState<Size | null>(null);
  const onCropComplete = useCallback((croppedArea: Area, croppedAreaPixels: Area) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  useEffect(() => {
    if (!imgSrc) {
      setAutoBackgroundColorHex('#9fccb9');
      return;
    }

    let cancelled = false;
    resolveImageBackgroundColorHex(imgSrc)
      .then((nextColor) => {
        if (!cancelled) {
          setAutoBackgroundColorHex(nextColor);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAutoBackgroundColorHex('#9fccb9');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [imgSrc]);

  const previewContainerRef = useCallback((node: HTMLDivElement | null) => {
    previewResizeObserverRef.current?.disconnect();
    previewResizeObserverRef.current = null;

    if (!node) {
      setPreviewContainerSize(null);
      return;
    }

    const updatePreviewContainerSize = () => {
      const nextRect = node.getBoundingClientRect();
      setPreviewContainerSize({
        width: nextRect.width,
        height: nextRect.height,
      });
    };

    updatePreviewContainerSize();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const resizeObserver = new ResizeObserver(updatePreviewContainerSize);
    resizeObserver.observe(node);
    previewResizeObserverRef.current = resizeObserver;
  }, []);

  useEffect(() => {
    return () => {
      previewResizeObserverRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (imgSrc) {
      setBackgroundFillMode('auto');
    }
  }, [imgSrc]);

  const backgroundColorHex = backgroundFillMode === 'custom' ? customBackgroundColorHex : autoBackgroundColorHex;
  const canUseEyeDropper =
    typeof window !== 'undefined' && typeof (window as WindowWithEyeDropper).EyeDropper !== 'undefined';
  const isImageCentered = Math.abs(crop.x) < 1 && Math.abs(crop.y) < 1;
  const explicitCropSize = useMemo(() => {
    if (!previewContainerSize) {
      return undefined;
    }

    const aspect = typeToAspectRatio[props.type];
    const width = previewContainerSize.width;
    const height = previewContainerSize.height;
    if (width <= 0 || height <= 0) {
      return undefined;
    }

    const maxWidth = Math.min(width, height * aspect);
    const maxHeight = maxWidth / aspect;

    return {
      width: Math.round(maxWidth),
      height: Math.round(maxHeight),
    };
  }, [previewContainerSize, props.type]);
  const fitZoom = useMemo(() => {
    if (!mediaSize || !explicitCropSize) {
      return null;
    }

    const rotatedMediaSize = rotateSize(mediaSize.width, mediaSize.height, rotation);
    const nextFitZoom = Math.min(
      explicitCropSize.width / rotatedMediaSize.width,
      explicitCropSize.height / rotatedMediaSize.height
    );

    return Number.isFinite(nextFitZoom) && nextFitZoom > 0 ? nextFitZoom : 1;
  }, [explicitCropSize, mediaSize, rotation]);

  useEffect(() => {
    if (fitZoom === null) {
      return;
    }

    setMinZoom(fitZoom);
    setZoom(fitZoom);
  }, [fitZoom]);
  const cropperReady = Boolean(explicitCropSize && mediaSize);

  function onSelectFile(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      setCrop({ x: 0, y: 0 }); // Makes crop preview update between images.
      setRotation(0);
      setMinZoom(1);
      setMediaSize(null);
      setBackgroundFillMode('auto');
      setCustomBackgroundColorHex('#000000');
      const reader = new FileReader();
      reader.addEventListener('load', () => setImgSrc(reader.result?.toString() || ''));
      reader.readAsDataURL(e.target.files[0]);
      if (props.title === '') {
        props.setTitle(e.target.files[0].name.split('.')[0]);
      }
      setImageType(e.target.files[0].type.split('/').pop()!);
    }
  }

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleClose = useCallback(() => {
    setImgSrc(undefined);
    setIsCropping(false);
    props.onCancel?.();
  }, [props]);

  const handleMediaLoaded = useCallback((loadedMediaSize: MediaSize) => {
    setMediaSize(loadedMediaSize);
    setCrop({ x: 0, y: 0 });
  }, []);

  const centerImage = useCallback(() => {
    setCrop({ x: 0, y: 0 });
  }, []);

  const handleCustomColorChange = useCallback((nextColor: string) => {
    setCustomBackgroundColorHex(nextColor);
    setBackgroundFillMode('custom');
  }, []);

  const pickCustomColor = useCallback(async () => {
    const eyeDropperCtor = (window as WindowWithEyeDropper).EyeDropper;
    if (!eyeDropperCtor || isCropping) {
      return;
    }

    try {
      setIsPickingColor(true);
      const eyeDropper = new eyeDropperCtor();
      const result = await eyeDropper.open();
      handleCustomColorChange(result.sRGBHex);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Failed to pick custom background color', error);
      }
    } finally {
      setIsPickingColor(false);
    }
  }, [handleCustomColorChange, isCropping]);

  if (!imgSrc) {
    return (
      <>
        <input type="file" accept="image/*" onChange={onSelectFile} ref={inputRef} style={{ display: 'none' }} />
        <Button variant="contained" onClick={handleClick}>
          Upload Image
        </Button>
      </>
    );
  }
  return (
    <DynamicPopUp
      title="Crop Image"
      open={true}
      setOpen={(bool) => {
        if (!bool) {
          handleClose();
        }
      }}
      dialogProps={{ fullWidth: true, maxWidth: 'lg' }}
      button={
        <Button
          onClick={async () => {
            if (!imgSrc || !croppedAreaPixels || isCropping) {
              return;
            }

            try {
              setIsCropping(true);
              const croppedImage = await getCroppedImg(
                imgSrc,
                croppedAreaPixels,
                rotation,
                props.type,
                backgroundColorHex
              );
              if (croppedImage) {
                await props.onFinish(croppedImage, `${props.title}-${props.type}.${imageType}`);
                handleClose();
              }
            } finally {
              setIsCropping(false);
            }
          }}
          variant="contained"
          color="primary"
          classes={{ root: styles.cropButton }}
          disabled={props.title === '' || isCropping}
        >
          {isCropping ? 'Cropping…' : 'Crop'}
        </Button>
      }
    >
      <div>
        <Box
          ref={previewContainerRef}
          className={styles.cropContainer}
          sx={{
            overflow: 'hidden',
            borderRadius: 2,
            backgroundColor: backgroundColorHex,
            minHeight: { xs: 360, sm: 460, md: 560 },
            height: 'min(68vh, 720px)',
          }}
        >
          <Cropper
            image={imgSrc}
            crop={crop}
            rotation={rotation}
            zoom={zoom}
            minZoom={minZoom}
            aspect={typeToAspectRatio[props.type]}
            cropSize={explicitCropSize}
            onCropChange={setCrop}
            onRotationChange={setRotation}
            onCropComplete={onCropComplete}
            onZoomChange={setZoom}
            onMediaLoaded={handleMediaLoaded}
            restrictPosition={false}
            objectFit="contain"
            style={{
              containerStyle: {
                backgroundColor: backgroundColorHex,
                opacity: cropperReady ? 1 : 0.01,
                transition: 'opacity 120ms ease',
              },
              cropAreaStyle: {
                width: explicitCropSize ? `${explicitCropSize.width}px` : undefined,
                height: explicitCropSize ? `${explicitCropSize.height}px` : undefined,
              },
            }}
          />
          {!cropperReady && (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1,
              }}
            >
              <CircularProgress />
            </Box>
          )}
          {cropperReady && !isCropping && !isImageCentered && (
            <Button
              variant="contained"
              size="small"
              onClick={centerImage}
              sx={{
                position: 'absolute',
                left: 12,
                bottom: 12,
                zIndex: 2,
                textTransform: 'none',
                backdropFilter: 'blur(4px)',
              }}
            >
              Center Image
            </Button>
          )}
          {isCropping && (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'column',
                gap: 1.5,
                backgroundColor: 'rgba(15, 23, 42, 0.28)',
                backdropFilter: 'blur(2px)',
                zIndex: 2,
                animation: 'cropPulse 1.4s ease-in-out infinite',
                '@keyframes cropPulse': {
                  '0%': { opacity: 0.8 },
                  '50%': { opacity: 1 },
                  '100%': { opacity: 0.8 },
                },
              }}
            >
              <CircularProgress color="inherit" />
              <Typography variant="body2" sx={{ color: '#fff', fontWeight: 600 }}>
                Preparing cropped image…
              </Typography>
            </Box>
          )}
        </Box>
        <div className={styles.controls}>
          <div className={styles.sliderContainer}>
            <Typography variant="overline" classes={{ root: styles.sliderLabel }}>
              Zoom
            </Typography>
            <Slider
              value={zoom}
              min={minZoom}
              max={3}
              step={0.01}
              aria-labelledby="Zoom"
              classes={{ root: styles.slider }}
              disabled={isCropping}
              onChange={(e, zoom) => {
                if (typeof zoom === 'number') {
                  setZoom(zoom);
                }
              }}
            />
          </div>
          <Stack spacing={1.25} sx={{ mt: 2 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography variant="overline" classes={{ root: styles.sliderLabel }}>
                Background Fill
              </Typography>
              <Box
                sx={{
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  backgroundColor: backgroundColorHex,
                  border: '1px solid',
                  borderColor: 'divider',
                  flexShrink: 0,
                }}
              />
              <Typography variant="body2" color="text.secondary">
                {backgroundFillMode === 'auto' ? `Auto ${autoBackgroundColorHex}` : `Custom ${customBackgroundColorHex}`}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Chip
                label={`Auto ${autoBackgroundColorHex}`}
                color={backgroundFillMode === 'auto' ? 'primary' : 'default'}
                variant={backgroundFillMode === 'auto' ? 'filled' : 'outlined'}
                disabled={isCropping}
                onClick={() => setBackgroundFillMode('auto')}
              />
              <Chip
                label={`Custom ${customBackgroundColorHex}`}
                color={backgroundFillMode === 'custom' ? 'primary' : 'default'}
                variant={backgroundFillMode === 'custom' ? 'filled' : 'outlined'}
                disabled={isCropping}
                onClick={() => setBackgroundFillMode('custom')}
              />
              <TextField
                type="color"
                size="small"
                value={customBackgroundColorHex}
                disabled={isCropping}
                onChange={(event) => handleCustomColorChange(event.target.value)}
                sx={{
                  width: 56,
                  '& input': {
                    cursor: 'pointer',
                    padding: 0.5,
                    minHeight: 32,
                  },
                }}
              />
              {canUseEyeDropper && (
                <IconButton
                  color={backgroundFillMode === 'custom' ? 'primary' : 'default'}
                  disabled={isCropping || isPickingColor}
                  onClick={pickCustomColor}
                  title="Pick a custom background color"
                  aria-label="Pick a custom background color"
                >
                  <ColorizeIcon />
                </IconButton>
              )}
            </Stack>
          </Stack>
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
              disabled={isCropping}
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
              disabled={isCropping}
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
