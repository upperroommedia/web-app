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
  baseButtonDisabled: boolean;
  date: Date;
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
  baseButtonDisabled,
  date,
  setUploadProgress,
  setIsUploading,
  clearForm,
}: UploadButtonProps) {
  return (
    <input
      className={styles.button}
      type="button"
      value="Upload"
      disabled={audioSource === undefined || baseButtonDisabled}
      onClick={async () => {
        if (audioSource !== undefined && date != null && user.isUploader()) {
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
        } else if (!user.isUploader()) {
          setUploadProgress({ error: true, message: 'You do not have permission to upload', percent: 0 });
        }
      }}
    />
  );
}
