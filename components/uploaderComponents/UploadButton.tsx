import React, { Dispatch, SetStateAction } from 'react';
import uploadFile, { AudioSource } from '../../pages/api/uploadFile';
import { User } from '../../types/User';
import { UploadProgress } from '../../context/types';
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
  setUploadProgress: Dispatch<SetStateAction<UploadProgress>>;
  setInvalidFormMessage: Dispatch<SetStateAction<string | undefined>>;
  setIsUploading: Dispatch<SetStateAction<boolean>>;
  clearForm: () => void;
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
  clearForm,
}: UploadButtonProps) {
  return (
    <Button
      variant="contained"
      color="primary"
      startIcon={<CloudUploadIcon />}
      onClick={async () => {
        // if (audioSource !== undefined && date != null && user.canUpload()) {
        if (validateForm() && audioSource != null) {
          try {
            setIsUploading(true);
            await uploadFile({
              audioSource,
              setUploadProgress,
              trimStart,
              sermon,
              sermonList,
            });
            clearForm();
          } catch (error) {
            setUploadProgress({ error: true, message: `Error uploading file: ${error}`, percent: 0 });
          } finally {
            setIsUploading(false);
          }
        } else if (!user.canUpload()) {
          setUploadProgress({ error: true, message: 'You do not have permission to upload', percent: 0 });
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
