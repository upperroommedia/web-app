import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ImageSizeType, ImageType, isImageType } from '../types/Image';
import ImageViewer from './ImageViewer';
import PopUp from './PopUp';
import Image from 'next/image';
import ImageUploader from './ImageUploader';
import firestore, { collection, getDocs, onSnapshot, query, where } from '../firebase/firestore';
import { imageStorage, ref, uploadBytes } from '../firebase/storage';
import { CroppedImageData } from '../utils/cropImage';
import { SpeakerRequestImageAsset } from '@upperroom/contracts/speakerRequests/speakerRequestTypes';

export interface CreateSpeakerFormValues {
  name: string;
  shortDescription?: string;
  description?: string;
  images: ImageType[];
  createSpeakerList: boolean;
}

const emptyCreateSpeakerForm: CreateSpeakerFormValues = {
  name: '',
  shortDescription: '',
  description: '',
  images: [],
  createSpeakerList: false,
};

interface CreateSpeakerPopupProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  onSubmit: (values: CreateSpeakerFormValues) => Promise<void>;
  initialValues?: Partial<CreateSpeakerFormValues>;
  requestedImageAsset?: SpeakerRequestImageAsset;
  title?: string;
  submitLabel?: string;
}

const IMAGE_SAVE_TIMEOUT_MS = 30000;
const IMAGE_NAME_MAX_ATTEMPTS = 50;
const MAX_SPEAKER_NAME_LENGTH = 30;

const buildIncrementedImageName = (name: string, increment: number): string => {
  const extensionIndex = name.lastIndexOf('.');
  if (extensionIndex <= 0) {
    return `${name}-${increment}`;
  }

  const baseName = name.slice(0, extensionIndex);
  const extension = name.slice(extensionIndex);
  const imageTypeSuffixMatch = baseName.match(/-(square|wide|banner)$/);

  if (imageTypeSuffixMatch) {
    const imageTypeSuffix = imageTypeSuffixMatch[0];
    const nameWithoutTypeSuffix = baseName.slice(0, -imageTypeSuffix.length);
    return `${nameWithoutTypeSuffix}-${increment}${imageTypeSuffix}${extension}`;
  }

  return `${baseName}-${increment}${extension}`;
};

const CreateSpeakerPopup = ({
  open,
  setOpen,
  onSubmit,
  initialValues,
  requestedImageAsset,
  title = 'Add Speaker',
  submitLabel = 'Create Speaker',
}: CreateSpeakerPopupProps) => {
  const [formValues, setFormValues] = useState<CreateSpeakerFormValues>(emptyCreateSpeakerForm);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [nameTouched, setNameTouched] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string>('');
  const [imageUploadError, setImageUploadError] = useState<string>('');
  const [imageUploading, setImageUploading] = useState<boolean>(false);
  const [requestedImageCropType, setRequestedImageCropType] = useState<ImageSizeType | null>(null);

  const hasSquareImage = useMemo(
    () => formValues.images.some((image) => image.type === 'square'),
    [formValues.images]
  );
  const normalizedName = formValues.name.trim();

  const resetForm = useCallback(() => {
    setFormValues({
      ...emptyCreateSpeakerForm,
      ...(initialValues ?? {}),
      images: initialValues?.images ?? emptyCreateSpeakerForm.images,
    });
    setNameTouched(false);
    setSubmitError('');
    setImageUploadError('');
    setImageUploading(false);
    setRequestedImageCropType(null);
  }, [initialValues]);

  useEffect(() => {
    if (open) {
      resetForm();
    }
  }, [open, resetForm]);

  const handleImageUpdate = useCallback((newImage: ImageType | ImageSizeType) => {
    setFormValues((oldFormValues) => {
      if (isImageType(newImage)) {
        const castedImage = newImage as ImageType;
        const hasMatchingType = oldFormValues.images.some((image) => image.type === castedImage.type);
        return {
          ...oldFormValues,
          images: hasMatchingType
            ? oldFormValues.images.map((image) => (image.type === castedImage.type ? castedImage : image))
            : [...oldFormValues.images, castedImage],
        };
      }

      const imageSizeType = newImage as ImageSizeType;
      return {
        ...oldFormValues,
        images: oldFormValues.images.filter((image) => image.type !== imageSizeType),
      };
    });
  }, []);

  const uploadTitle = normalizedName.replaceAll(' ', '-');

  const handleRequestedImageUpload = useCallback(
    async (croppedImageData: CroppedImageData, name: string) => {
      try {
        setImageUploading(true);
        setImageUploadError('');

        let resolvedName = name;
        let existingImageQuery = query(collection(firestore, 'images'), where('name', '==', resolvedName));
        let existingImageSnapshot = await getDocs(existingImageQuery);

        for (let increment = 2; !existingImageSnapshot.empty && increment <= IMAGE_NAME_MAX_ATTEMPTS; increment += 1) {
          resolvedName = buildIncrementedImageName(name, increment);
          existingImageQuery = query(collection(firestore, 'images'), where('name', '==', resolvedName));
          existingImageSnapshot = await getDocs(existingImageQuery);
        }

        if (!existingImageSnapshot.empty) {
          setImageUploadError('Unable to find a unique image name for this speaker image. Please try again.');
          setImageUploading(false);
          return;
        }

        const imageRef = ref(imageStorage, `speaker-images/${resolvedName}`);
        await uploadBytes(imageRef, croppedImageData.blob, {
          contentType: croppedImageData.contentType,
          customMetadata: { name: resolvedName, size: 'original', type: croppedImageData.type },
        });

        let unsubscribe: () => void = () => {};
        const timeoutId = window.setTimeout(() => {
          unsubscribe();
          setImageUploading(false);
            setImageUploadError('Image upload finished, but processing did not complete in time. Please try again.');
        }, IMAGE_SAVE_TIMEOUT_MS);

        unsubscribe = onSnapshot(existingImageQuery, (snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type !== 'added') {
              return;
            }

            const uploadedImage = change.doc.data() as ImageType;
            window.clearTimeout(timeoutId);
            setImageUploading(false);
            handleImageUpdate(uploadedImage);
            setRequestedImageCropType(null);
            unsubscribe();
          });
        });
      } catch (error) {
        setImageUploading(false);
        setImageUploadError(error instanceof Error ? error.message : 'Unable to upload requested image.');
      }
    },
    [handleImageUpdate]
  );

  const handleSubmit = async () => {
    if (!normalizedName || !hasSquareImage || submitting || imageUploading) {
      return;
    }

    setSubmitting(true);
    setSubmitError('');
    try {
      await onSubmit({
        ...formValues,
        name: normalizedName,
      });
      resetForm();
      setOpen(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Unable to create speaker.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitDisabled = submitting || imageUploading || normalizedName.length === 0 || !hasSquareImage;
  return (
    <PopUp
      title={title}
      open={open}
      setOpen={setOpen}
      onClose={resetForm}
      dialogProps={{ fullWidth: true, maxWidth: 'lg' }}
      button={
        <Button variant="contained" onClick={handleSubmit} disabled={submitDisabled}>
          {submitting ? <CircularProgress size={24} color="inherit" /> : submitLabel}
        </Button>
      }
    >
      <Stack spacing={2} sx={{ pt: 1 }}>
        <TextField
          label={nameTouched && normalizedName.length === 0 ? 'Speaker name is required' : 'Speaker Name'}
          value={formValues.name}
          required
          fullWidth
          error={nameTouched && normalizedName.length === 0}
          helperText={`${normalizedName.length}/${MAX_SPEAKER_NAME_LENGTH} characters`}
          inputProps={{ maxLength: MAX_SPEAKER_NAME_LENGTH }}
          onBlur={() => setNameTouched(true)}
          onChange={(event) => {
            if (!nameTouched) {
              setNameTouched(true);
            }
            setFormValues((oldFormValues) => ({ ...oldFormValues, name: event.target.value }));
          }}
        />
        <TextField
          label="Short Description (optional)"
          value={formValues.shortDescription ?? ''}
          fullWidth
          onChange={(event) => {
            setFormValues((oldFormValues) => ({ ...oldFormValues, shortDescription: event.target.value }));
          }}
        />
        <TextField
          label="Description (optional)"
          value={formValues.description ?? ''}
          fullWidth
          multiline
          minRows={3}
          onChange={(event) => {
            setFormValues((oldFormValues) => ({ ...oldFormValues, description: event.target.value }));
          }}
        />
        <FormControlLabel
          control={
            <Checkbox
              checked={formValues.createSpeakerList}
              onChange={(event) => {
                setFormValues((oldFormValues) => ({ ...oldFormValues, createSpeakerList: event.target.checked }));
              }}
            />
          }
          label="Create and associate a speaker list"
        />

        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Speaker Images
          </Typography>
          {requestedImageAsset && (
            <Stack spacing={1.5} sx={{ mb: 2 }}>
              <Typography variant="body2" color="text.secondary">
                A request image was included. You can crop it into square, wide, or banner images before creating the speaker.
              </Typography>
              <Box
                sx={{
                  position: 'relative',
                  width: { xs: '100%', sm: 220 },
                  maxWidth: 220,
                  aspectRatio: '1 / 1',
                  borderRadius: 1,
                  overflow: 'hidden',
                  border: '1px solid',
                  borderColor: 'divider',
                  backgroundColor: 'background.default',
                }}
                >
                  <Image
                    src={requestedImageAsset.downloadLink}
                    alt={requestedImageAsset.fileName}
                    fill
                    sizes="(max-width: 600px) 100vw, 220px"
                  style={{ objectFit: 'contain' }}
                />
              </Box>
              {requestedImageCropType && (
                <ImageUploader
                  imgSrc={requestedImageAsset.downloadLink}
                  onFinish={handleRequestedImageUpload}
                  onCancel={() => setRequestedImageCropType(null)}
                  type={requestedImageCropType}
                  title={uploadTitle}
                  setTitle={() => {}}
                  sourceFileName={requestedImageAsset.fileName}
                />
              )}
            </Stack>
          )}
          <ImageViewer
            images={formValues.images}
            newImageCallback={handleImageUpdate}
            requiredTypes={['square']}
            renderHeaderForType={
              requestedImageAsset
                ? (type, image) => (
                    <Button
                      variant="outlined"
                      fullWidth
                      disabled={imageUploading || normalizedName.length === 0}
                      onClick={() => setRequestedImageCropType(type)}
                      sx={{ textTransform: 'none' }}
                    >
                      {image ? `Replace ${type} image` : `Create ${type} image`}
                    </Button>
                  )
                : undefined
            }
          />
        </Box>

        {imageUploading && <Alert severity="info">Uploading cropped speaker image…</Alert>}
        {imageUploadError && <Alert severity="error">{imageUploadError}</Alert>}
        {submitError && <Alert severity="error">{submitError}</Alert>}
      </Stack>
    </PopUp>
  );
};

export default CreateSpeakerPopup;
