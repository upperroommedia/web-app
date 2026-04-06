/**
 * NewSeriesPopup: Modal for creating a new media series
 * - Creates series in Firestore only (no Subsplash until publish)
 * - Sets ownerId to current user
 * - Supports name, summary, and images
 */
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { ImageSizeType, ImageType, isImageType } from '../types/Image';
import ImageViewer from './ImageViewer';
import PopUp from './PopUp';
import useAuth from '../context/user/UserContext';
import { createFunctionV2 } from '../utils/createFunction';
import { CreateSeriesInputType, CreateSeriesOutputType } from '@upperroom/contracts/createSeries';
import { Series, emptySeries } from '../types/Series';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { saveSeriesMetadata } from '../utils/saveSeriesMetadata';

interface NewSeriesPopupProps {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  onSeriesCreated?: (series: Series) => void;
  existingSeries?: Series; // For editing existing series
}

const createSeriesFunction = createFunctionV2<CreateSeriesInputType, CreateSeriesOutputType>('createseries');

const NewSeriesPopup = (props: NewSeriesPopupProps) => {
  const { user } = useAuth();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [formData, setFormData] = useState<{
    name: string;
    summary: string;
    images: ImageType[];
  }>({
    name: props.existingSeries?.name ?? '',
    summary: props.existingSeries?.summary ?? '',
    images: props.existingSeries?.images ?? [],
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when existing series changes
  useEffect(() => {
    if (props.existingSeries) {
      queueMicrotask(() => {
        setFormData({
          name: props.existingSeries?.name ?? '',
          summary: props.existingSeries?.summary ?? '',
          images: props.existingSeries?.images ?? [],
        });
      });
    }
  }, [props.existingSeries]);

  useEffect(() => {
    if (!props.open) return;
    const focusTimer = window.setTimeout(() => {
      nameInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [props.open]);

  const handleImageChange = useCallback((image: ImageType | ImageSizeType) => {
    setFormData((prev) => {
      if (isImageType(image)) {
        const castedImage = image as ImageType;
        let newImages: ImageType[];
        if (prev.images.find((img) => img.type === castedImage.type)) {
          newImages = prev.images.map((img) => (img.type === castedImage.type ? castedImage : img));
        } else {
          newImages = [...prev.images, castedImage];
        }
        return { ...prev, images: newImages };
      } else {
        const imageSizeType = image as ImageSizeType;
        return {
          ...prev,
          images: prev.images.filter((img) => img.type !== imageSizeType),
        };
      }
    });
  }, []);

  const handleSubmit = async () => {
    if (!user) {
      setError('You must be logged in to create a series');
      return;
    }

    if (!formData.name.trim()) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      // Published series sync to Subsplash immediately; drafts stay local-only.
      if (props.existingSeries) {
        const updatedSeries = await saveSeriesMetadata({
          series: props.existingSeries,
          name: formData.name,
          summary: formData.summary,
          images: formData.images,
        });

        props.onSeriesCreated?.(updatedSeries);
        props.setOpen(false);
      } else {
        // Creating new series
        const result = await createSeriesFunction({
          title: formData.name.trim(),
          summary: formData.summary.trim() || undefined,
          ownerId: user.uid,
          skipSubsplash: true, // Only create in Firestore at upload time
          images: formData.images,
        });

        if (result.status === 'success' && result.firestoreId) {
          // Create a Series object to pass back
          const newSeries: Series = {
            ...emptySeries,
            id: result.firestoreId,
            name: formData.name.trim(),
            subtitle: '0 part series',
            summary: formData.summary.trim() || undefined,
            images: formData.images,
            ownerId: user.uid,
            subsplashId: '', // Not yet published
            status: 'draft',
          };

          props.onSeriesCreated?.(newSeries);
          props.setOpen(false);

          // Reset form
          setFormData({
            name: '',
            summary: '',
            images: [],
          });
        } else {
          setError(result.error || 'Failed to create series');
        }
      }
    } catch (err: unknown) {
      console.error('Error saving series:', err);
      const message = err instanceof Error ? err.message : 'An unexpected error occurred';
      setError(message);
    }

    setSubmitting(false);
  };

  const handleClose = () => {
    // Reset to existing series data if editing, otherwise clear form
    if (props.existingSeries) {
      setFormData({
        name: props.existingSeries.name,
        summary: props.existingSeries.summary ?? '',
        images: props.existingSeries.images,
      });
    } else {
      setFormData({
        name: '',
        summary: '',
        images: [],
      });
    }
    setError(null);
  };

  const nameError = formData.name.trim() ? null : 'Name is required';
  const hasWideImage = formData.images.some((image) => image.type === 'wide');
  const hasBannerImage = formData.images.some((image) => image.type === 'banner');
  const missingRequiredImages = [
    !hasWideImage ? 'wide' : null,
    !hasBannerImage ? 'banner' : null,
  ].filter((value): value is 'wide' | 'banner' => value !== null);
  const isValid = formData.name.trim() !== '' && missingRequiredImages.length === 0;

  return (
    <PopUp
      title={props.existingSeries ? `Edit ${props.existingSeries.name}` : 'Create New Series'}
      open={props.open}
      setOpen={props.setOpen}
      onClose={handleClose}
      dialogProps={{ fullWidth: true, maxWidth: 'lg', fullScreen: isMobile }}
      button={
        <Button
          variant="contained"
          disabled={!isValid || submitting}
          onClick={handleSubmit}
        >
          {submitting ? <CircularProgress size={24} /> : props.existingSeries ? 'Save Changes' : 'Create Series'}
        </Button>
      }
    >
      <Box display="flex" padding={{ xs: '4px', sm: '12px', md: '16px' }} justifyContent="center" flexDirection="column" gap={2.5}>
        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        <TextField
          autoFocus
          inputRef={nameInputRef}
          value={formData.name}
          onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
          error={!!nameError && formData.name !== ''}
          label="Name"
          required
          helperText={nameError && formData.name !== '' ? nameError : 'The series title'}
        />

        <TextField
          value={formData.summary}
          onChange={(e) => setFormData((prev) => ({ ...prev, summary: e.target.value }))}
          label="Summary"
          multiline
          rows={3}
          helperText="Optional description of the series"
        />

        <Box>
          <ImageViewer
            images={formData.images}
            newImageCallback={handleImageChange}
            vertical={false}
            requiredTypes={['wide', 'banner']}
          />
        </Box>
      </Box>
    </PopUp>
  );
};

export default NewSeriesPopup;
