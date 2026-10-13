import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageSizeType, ImageType, isImageType } from '../types/Image';
import ImageViewer from './ImageViewer';
import PopUp from './PopUp';
import Image from 'next/image';
import ImageUploader from './ImageUploader';
import firestore, { doc, getDoc } from '../firebase/firestore';
import { ingestDurableImage } from '../utils/durableImages';
import { useDurableJob } from '../hooks/useDurableJobs';
import JobStatusPanel from './jobs/JobStatusPanel';
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

const MAX_SPEAKER_NAME_LENGTH = 30;

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
  const [imageJobId, setImageJobId] = useState<string>();
  const { job: imageJob, stale: imageJobStale } = useDurableJob(imageJobId);
  const handledImageJob = useRef<string | undefined>(undefined);
  const [requestedImageCropType, setRequestedImageCropType] = useState<ImageSizeType | null>(null);

  const hasSquareImage = useMemo(() => formValues.images.some((image) => image.type === 'square'), [formValues.images]);
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

  const handleRequestedImageUpload = useCallback(async (croppedImageData: CroppedImageData, name: string) => {
    setImageUploading(true);
    setImageUploadError('');
    try {
      const receipt = await ingestDurableImage(croppedImageData, name);
      setImageJobId(receipt.jobId);
      setRequestedImageCropType(null);
    } catch (error) {
      setImageUploadError(
        error instanceof Error ? error.message : 'Unable to confirm this image request. The source has been kept.'
      );
      throw error;
    } finally {
      setImageUploading(false);
    }
  }, []);
  useEffect(() => {
    if (imageJob?.state !== 'succeeded' || handledImageJob.current === imageJob.jobId) return;
    const imageId = imageJob.result?.imageId;
    if (typeof imageId !== 'string') return;
    let cancelled = false;
    getDoc(doc(firestore, 'images', imageId))
      .then((snapshot) => {
        if (cancelled || !snapshot.exists()) return;
        handledImageJob.current = imageJob.jobId;
        handleImageUpdate({ ...snapshot.data(), id: snapshot.id } as ImageType);
      })
      .catch(() => {
        if (!cancelled)
          setImageUploadError(
            'Image processing completed, but its details could not be refreshed. Select it from the image library.'
          );
      });
    return () => {
      cancelled = true;
    };
  }, [imageJob, handleImageUpdate]);

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
                A request image was included. You can crop it into square, wide, or banner images before creating the
                speaker.
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

        {imageUploading && <Alert severity="info">Sending cropped image…</Alert>}
        {imageJob && <JobStatusPanel job={imageJob} stale={imageJobStale} compact />}
        {imageUploadError && <Alert severity="error">{imageUploadError}</Alert>}
        {submitError && <Alert severity="error">{submitError}</Alert>}
      </Stack>
    </PopUp>
  );
};

export default CreateSpeakerPopup;
