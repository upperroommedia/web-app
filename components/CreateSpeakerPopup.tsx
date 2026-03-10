import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { Dispatch, SetStateAction, useCallback, useMemo, useState } from 'react';
import { ImageSizeType, ImageType, isImageType } from '../types/Image';
import ImageViewer from './ImageViewer';
import PopUp from './PopUp';

export interface CreateSpeakerFormValues {
  name: string;
  sermonCount?: number;
  images: ImageType[];
  createSpeakerList: boolean;
}

const emptyCreateSpeakerForm: CreateSpeakerFormValues = {
  name: '',
  images: [],
  createSpeakerList: false,
};

interface CreateSpeakerPopupProps {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  onSubmit: (values: CreateSpeakerFormValues) => Promise<void>;
}

const CreateSpeakerPopup = ({ open, setOpen, onSubmit }: CreateSpeakerPopupProps) => {
  const [formValues, setFormValues] = useState<CreateSpeakerFormValues>(emptyCreateSpeakerForm);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [nameTouched, setNameTouched] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string>('');

  const hasSquareImage = useMemo(
    () => formValues.images.some((image) => image.type === 'square'),
    [formValues.images]
  );
  const normalizedName = formValues.name.trim();

  const resetForm = useCallback(() => {
    setFormValues(emptyCreateSpeakerForm);
    setNameTouched(false);
    setSubmitError('');
  }, []);

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

  const handleSubmit = async () => {
    if (!normalizedName || !hasSquareImage || submitting) {
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

  const submitDisabled = submitting || normalizedName.length === 0 || !hasSquareImage;
  const sermonCountValue = formValues.sermonCount ?? '';

  return (
    <PopUp
      title="Add Speaker"
      open={open}
      setOpen={setOpen}
      onClose={resetForm}
      dialogProps={{ fullWidth: true, maxWidth: 'lg' }}
      button={
        <Button variant="contained" onClick={handleSubmit} disabled={submitDisabled}>
          {submitting ? <CircularProgress size={24} color="inherit" /> : 'Create Speaker'}
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
          onBlur={() => setNameTouched(true)}
          onChange={(event) => {
            if (!nameTouched) {
              setNameTouched(true);
            }
            setFormValues((oldFormValues) => ({ ...oldFormValues, name: event.target.value }));
          }}
        />
        <TextField
          label="Sermon Count (optional)"
          type="number"
          value={sermonCountValue}
          inputProps={{ min: 0 }}
          onChange={(event) => {
            const value = event.target.value;
            setFormValues((oldFormValues) => ({
              ...oldFormValues,
              sermonCount: value === '' ? undefined : Math.max(0, Number(value)),
            }));
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
          <ImageViewer images={formValues.images} newImageCallback={handleImageUpdate} />
        </Box>

        {!hasSquareImage && (
          <Alert severity="warning">A square image is required before you can create a speaker.</Alert>
        )}

        {submitError && <Alert severity="error">{submitError}</Alert>}
      </Stack>
    </PopUp>
  );
};

export default CreateSpeakerPopup;
