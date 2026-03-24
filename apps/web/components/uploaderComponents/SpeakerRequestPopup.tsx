import Alert, { AlertColor } from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import Image from 'next/image';
import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { CreateSpeakerRequestInputType, CreateSpeakerRequestOutputType } from '@upperroom/contracts/speakerRequests/speakerRequestTypes';
import { createFunctionV2 } from '../../utils/createFunction';
import PopUp from '../PopUp';
import storage, { getDownloadURL, ref, uploadBytes } from '../../firebase/storage';

interface SpeakerRequestPopupProps {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const createSpeakerRequest = createFunctionV2<CreateSpeakerRequestInputType, CreateSpeakerRequestOutputType>(
  'createspeakerrequest'
);

const emptyState = {
  speakerName: '',
  description: '',
};

const sanitizeFileSegment = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

const SpeakerRequestPopup = ({ open, setOpen }: SpeakerRequestPopupProps) => {
  const [speakerName, setSpeakerName] = useState(emptyState.speakerName);
  const [description, setDescription] = useState(emptyState.description);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ severity: AlertColor; message: string } | null>(null);
  const [submittedSpeakerName, setSubmittedSpeakerName] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl(null);
      return;
    }

    const nextPreviewUrl = URL.createObjectURL(selectedFile);
    setPreviewUrl(nextPreviewUrl);
    return () => URL.revokeObjectURL(nextPreviewUrl);
  }, [selectedFile]);

  const resetForm = () => {
    setSpeakerName(emptyState.speakerName);
    setDescription(emptyState.description);
    setSelectedFile(null);
    setFeedback(null);
    setSubmittedSpeakerName(null);
  };

  const normalizedSpeakerName = speakerName.trim();
  const normalizedDescription = description.trim();
  const submitDisabled = submitting || !normalizedSpeakerName || !normalizedDescription || !selectedFile;

  const rawImageFileName = useMemo(() => {
    if (!selectedFile) {
      return '';
    }

    const extension = selectedFile.name.includes('.') ? selectedFile.name.split('.').pop() ?? 'jpg' : 'jpg';
    const safeSpeakerName = sanitizeFileSegment(normalizedSpeakerName || selectedFile.name.replace(/\.[^.]+$/, ''));
    return `${safeSpeakerName || 'speaker-request'}-${Date.now()}.${extension}`;
  }, [normalizedSpeakerName, selectedFile]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setFeedback(null);
  };

  const handleSubmit = async () => {
    if (submitDisabled || !selectedFile) {
      return;
    }

    setSubmitting(true);
    setFeedback(null);

    try {
      const storagePath = `speaker-request-images/${Date.now()}-${rawImageFileName}`;
      const storageRef = ref(storage, storagePath);
      await uploadBytes(storageRef, selectedFile, {
        contentType: selectedFile.type || 'application/octet-stream',
        customMetadata: {
          speakerName: normalizedSpeakerName,
          originalFileName: selectedFile.name,
        },
      });

      const downloadLink = await getDownloadURL(storageRef);

      const response = await createSpeakerRequest({
        speakerName: normalizedSpeakerName,
        description: normalizedDescription,
        image: {
          downloadLink,
          storagePath,
          fileName: selectedFile.name,
          contentType: selectedFile.type || 'application/octet-stream',
        },
      });

      if (response.status === 'error') {
        throw new Error(response.error);
      }

      const warningText = response.data.warning ? ` ${response.data.warning.message}` : '';
      const message =
        response.data.requestStatus === 'existing'
          ? `A pending speaker request for ${normalizedSpeakerName} already exists.${warningText}`
          : `Your speaker request for ${normalizedSpeakerName} has been submitted.${warningText}`;

      setFeedback({
        severity: response.data.warning ? 'warning' : 'success',
        message,
      });

      if (response.data.requestStatus === 'created') {
        setSubmittedSpeakerName(normalizedSpeakerName);
        setSpeakerName(emptyState.speakerName);
        setDescription(emptyState.description);
        setSelectedFile(null);
      }
    } catch (error) {
      setFeedback({
        severity: 'error',
        message: error instanceof Error ? error.message : 'Failed to submit speaker request.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PopUp
      title="Request New Speaker"
      open={open}
      setOpen={setOpen}
      onClose={resetForm}
      dialogProps={{ fullWidth: true, maxWidth: 'md' }}
      button={
        submittedSpeakerName ? (
          <Button variant="contained" onClick={() => setOpen(false)}>
            Close
          </Button>
        ) : (
          <Button variant="contained" onClick={handleSubmit} disabled={submitDisabled}>
            {submitting ? <CircularProgress size={20} color="inherit" /> : 'Submit Request'}
          </Button>
        )
      }
    >
      {submittedSpeakerName ? (
        <Stack spacing={2} sx={{ pt: 1, alignItems: 'center', textAlign: 'center' }}>
          <CheckCircleOutlineIcon sx={{ fontSize: 72, color: 'success.main' }} />
          <Typography variant="h5" fontWeight={700} color="success.main">
            Request Sent
          </Typography>
          <Typography variant="body1">
            Your speaker request for {submittedSpeakerName} was sent successfully.
          </Typography>
          <Alert severity="success" sx={{ width: '100%' }}>
            You should receive an email when the request has been actioned by Upper Room Media &lt;no-reply@upperroommedia.org&gt;.
          </Alert>
        </Stack>
      ) : (
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Tell an admin who the speaker is and include a picture. The image will stay unprocessed until an admin creates the speaker.
          </Typography>
          {feedback && <Alert severity={feedback.severity}>{feedback.message}</Alert>}
          <TextField
            label="Full Speaker Name"
            required
            fullWidth
            value={speakerName}
            disabled={submitting}
            onChange={(event) => setSpeakerName(event.target.value)}
          />
          <TextField
            label="Description"
            required
            multiline
            minRows={4}
            fullWidth
            value={description}
            disabled={submitting}
            onChange={(event) => setDescription(event.target.value)}
          />
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Speaker Picture
            </Typography>
            <Button component="label" variant="outlined" disabled={submitting} sx={{ textTransform: 'none' }}>
              {selectedFile ? 'Choose a different image' : 'Choose image'}
              <input hidden accept="image/*" type="file" onChange={handleFileChange} />
            </Button>
            {selectedFile && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {selectedFile.name}
              </Typography>
            )}
            {previewUrl && (
              <Box
                sx={{
                  position: 'relative',
                  mt: 1.5,
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
                  src={previewUrl}
                  alt={selectedFile?.name ?? 'Speaker preview'}
                  fill
                  sizes="(max-width: 600px) 100vw, 220px"
                  style={{ objectFit: 'contain' }}
                />
              </Box>
            )}
          </Box>
          {!selectedFile && <Alert severity="warning">A speaker picture is required before you can submit.</Alert>}
        </Stack>
      )}
    </PopUp>
  );
};

export default SpeakerRequestPopup;
