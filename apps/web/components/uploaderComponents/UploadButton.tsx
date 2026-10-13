import React, { Dispatch, SetStateAction, useRef, useState } from 'react';
import uploadFile, { AudioSource, AudioAdmissionReceipt, AudioTransferProgress } from '../../utils/uploadFile';
import { User } from '../../types/User';
import { List } from '../../types/List';
import { Sermon } from '../../types/SermonTypes';
import Button from '@mui/material/Button';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';

interface UploadButtonProps {
  user: User;
  sermon: Sermon;
  audioSource: AudioSource | undefined;
  trimStart: number;
  sermonList: List[];
  date: Date;
  validateForm: () => boolean;
  setUploadProgress: Dispatch<SetStateAction<AudioTransferProgress>>;
  setInvalidFormMessage: Dispatch<SetStateAction<string | undefined>>;
  setIsUploading: Dispatch<SetStateAction<boolean>>;
  receipt?: AudioAdmissionReceipt;
  onAdmission?: (receipt: AudioAdmissionReceipt) => void;
  onUploadSuccess?: (sermonId: string) => void | Promise<void>;
}

export default function UploadButton({
  user,
  sermon,
  audioSource,
  trimStart,
  sermonList,
  validateForm,
  setUploadProgress,
  setInvalidFormMessage,
  setIsUploading,
  onUploadSuccess,
  onAdmission,
  receipt,
}: UploadButtonProps) {
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  return (
    <Button
      variant="contained"
      color="primary"
      startIcon={<CloudUploadIcon />}
      disabled={submitting || !user.canUpload()}
      onClick={async () => {
        if (inFlight.current) return;
        if (!user.canUpload()) {
          setInvalidFormMessage('You do not have permission to upload');
          return;
        }
        if (validateForm() && audioSource != null) {
          inFlight.current = true;
          setSubmitting(true);
          try {
            setIsUploading(true);
            const completedAdmission = await uploadFile({
              audioSource,
              setUploadProgress,
              trimStart,
              sermon,
              sermonList,
              onAdmission,
              receipt,
            });
            // Call success callback with sermon ID
            if (completedAdmission.sermonId) await onUploadSuccess?.(completedAdmission.sermonId);
          } catch (_error) {
            // uploadFile preserves the durable receipt and reports a safe recovery message.
          } finally {
            setIsUploading(false);
            inFlight.current = false;
            setSubmitting(false);
          }
        } else {
          setInvalidFormMessage('Please make sure all required fields are filled out');
        }
      }}
      sx={{ minWidth: 120 }}
    >
      Upload
    </Button>
  );
}
