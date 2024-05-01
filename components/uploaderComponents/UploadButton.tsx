import React, { Dispatch, SetStateAction } from 'react';
import styles from '../../styles/Uploader.module.css';
import uploadFile, { AudioSource } from '../../pages/api/uploadFile';
import { User } from '../../types/User';
import { UploadProgress } from '../../context/types';
import { List } from '../../types/List';
import { Sermon } from '../../types/SermonTypes';

interface UploadButtonProps {
  user: User;
  sermon: Sermon;
  audioSource: AudioSource | undefined;
  trimStart: number;
  sermonList: List[];
  date: Date;
  validateForm: () => boolean;
  setUploadProgress: Dispatch<SetStateAction<UploadProgress>>;
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
  setIsUploading,
  clearForm,
}: UploadButtonProps) {
  return (
    <input
      className={styles.button}
      type="button"
      value="Upload"
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
          setUploadProgress({
            error: true,
            message: 'Please make sure all required fields are filled out',
            percent: 0,
          });
        }
      }}
    />
  );
}
