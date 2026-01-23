/**
 * NewSeriesPopup: Modal for creating a new media series
 * - Creates series in Firestore only (no Subsplash until publish)
 * - Sets ownerId to current user
 * - Supports name, subtitle, summary, and images
 */
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import { Dispatch, SetStateAction, useCallback, useEffect, useState } from 'react';
import { ImageSizeType, ImageType, isImageType } from '../types/Image';
import ImageViewer from './ImageViewer';
import PopUp from './PopUp';
import useAuth from '../context/user/UserContext';
import { createFunctionV2 } from '../utils/createFunction';
import { CreateSeriesInputType, CreateSeriesOutputType } from '../functions/src/createSeries';
import { Series, emptySeries } from '../types/Series';
import firestore, { doc, updateDoc } from '../firebase/firestore';
import { serverTimestamp } from 'firebase/firestore';

interface NewSeriesPopupProps {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  onSeriesCreated?: (series: Series) => void;
  existingSeries?: Series;  // For editing existing series
}

const createSeriesFunction = createFunctionV2<CreateSeriesInputType, CreateSeriesOutputType>('createseries');

const NewSeriesPopup = (props: NewSeriesPopupProps) => {
  const { user } = useAuth();
  const [formData, setFormData] = useState<{
    name: string;
    subtitle: string;
    summary: string;
    images: ImageType[];
  }>({
    name: props.existingSeries?.name ?? '',
    subtitle: props.existingSeries?.subtitle ?? '',
    summary: props.existingSeries?.summary ?? '',
    images: props.existingSeries?.images ?? [],
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  // Reset form when existing series changes
  useEffect(() => {
    if (props.existingSeries) {
      setFormData({
        name: props.existingSeries.name,
        subtitle: props.existingSeries.subtitle ?? '',
        summary: props.existingSeries.summary ?? '',
        images: props.existingSeries.images,
      });
    }
  }, [props.existingSeries]);

  // Validate name
  useEffect(() => {
    if (!formData.name.trim()) {
      setNameError('Name is required');
    } else {
      setNameError(null);
    }
  }, [formData.name]);

  const handleImageChange = useCallback((image: ImageType | ImageSizeType) => {
    setFormData((prev) => {
      if (isImageType(image)) {
        const castedImage = image as ImageType;
        let newImages: ImageType[];
        if (prev.images.find((img) => img.type === castedImage.type)) {
          newImages = prev.images.map((img) => 
            img.type === castedImage.type ? castedImage : img
          );
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
      setNameError('Name is required');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      // If editing existing series, update it directly in Firestore
      if (props.existingSeries) {
        await updateDoc(doc(firestore, 'series', props.existingSeries.id), {
          name: formData.name.trim(),
          subtitle: formData.subtitle.trim() || null,
          summary: formData.summary.trim() || null,
          images: formData.images,
          updatedAt: serverTimestamp(),
        });

        // Create updated series object to pass back
        const updatedSeries: Series = {
          ...props.existingSeries,
          name: formData.name.trim(),
          subtitle: formData.subtitle.trim() || undefined,
          summary: formData.summary.trim() || undefined,
          images: formData.images,
        };

        props.onSeriesCreated?.(updatedSeries);
        props.setOpen(false);
      } else {
        // Creating new series
        const result = await createSeriesFunction({
          title: formData.name.trim(),
          subtitle: formData.subtitle.trim() || undefined,
          summary: formData.summary.trim() || undefined,
          ownerId: user.uid,
          skipSubsplash: true,  // Only create in Firestore at upload time
          images: formData.images,
        });

        if (result.status === 'success' && result.firestoreId) {
          // Create a Series object to pass back
          const newSeries: Series = {
            ...emptySeries,
            id: result.firestoreId,
            name: formData.name.trim(),
            subtitle: formData.subtitle.trim() || undefined,
            summary: formData.summary.trim() || undefined,
            images: formData.images,
            ownerId: user.uid,
            subsplashId: '',  // Not yet published
            status: 'draft',
          };

          props.onSeriesCreated?.(newSeries);
          props.setOpen(false);
          
          // Reset form
          setFormData({
            name: '',
            subtitle: '',
            summary: '',
            images: [],
          });
        } else {
          setError(result.error || 'Failed to create series');
        }
      }
    } catch (err: any) {
      console.error('Error saving series:', err);
      setError(err.message || 'An unexpected error occurred');
    }

    setSubmitting(false);
  };

  const handleClose = () => {
    // Reset to existing series data if editing, otherwise clear form
    if (props.existingSeries) {
      setFormData({
        name: props.existingSeries.name,
        subtitle: props.existingSeries.subtitle ?? '',
        summary: props.existingSeries.summary ?? '',
        images: props.existingSeries.images,
      });
    } else {
      setFormData({
        name: '',
        subtitle: '',
        summary: '',
        images: [],
      });
    }
    setError(null);
    setNameError(null);
  };

  const isValid = formData.name.trim() !== '' && formData.images.length > 0;

  return (
    <PopUp
      title={props.existingSeries ? `Edit ${props.existingSeries.name}` : 'Create New Series'}
      open={props.open}
      setOpen={props.setOpen}
      onClose={handleClose}
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
      <Box display="flex" padding="10px" justifyContent="center" flexDirection="column" gap={2}>
        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        
        <TextField
          value={formData.name}
          onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
          error={!!nameError && formData.name !== ''}
          label="Name"
          required
          helperText={nameError && formData.name !== '' ? nameError : 'The series title'}
        />

        <TextField
          value={formData.subtitle}
          onChange={(e) => setFormData((prev) => ({ ...prev, subtitle: e.target.value }))}
          label="Subtitle"
          helperText="Optional subtitle for the series"
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
          />
          {formData.images.length === 0 && (
            <Alert severity="info" sx={{ mt: 1 }}>
              Please add at least one image for the series
            </Alert>
          )}
        </Box>
      </Box>
    </PopUp>
  );
};

export default NewSeriesPopup;
