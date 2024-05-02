import { Dispatch, SetStateAction, useCallback, useEffect, useState } from 'react';
import { FileRejection, useDropzone } from 'react-dropzone';
import styles from '../styles/DropZone.module.css';
import { AudioSource } from '../pages/api/uploadFile';
import { UploaderFieldError } from '../context/types';
import { getErrorMessage, showError } from './uploaderComponents/utils';
export interface UploadableFile {
  file: File;
  name: string;
  preview: string;
}

interface DropZoneProps {
  setAudioSource: Dispatch<SetStateAction<AudioSource | undefined>>;
  audioSourceError?: UploaderFieldError;
  setAudioSourceError: (error: boolean, message: string) => void;
}

function fileTypeValidator(file: File) {
  // reject any files over 500mb
  if (!file.type.includes('audio/')) return { code: 'file-type', message: 'File must be an audio file' };
  if (file.size > 500000000) {
    return { code: 'file-size', message: 'File size too large - 500mb max' };
  }
  return null;
}

let Url: any;
if (typeof window !== 'undefined') {
  Url = window.URL || window.webkitURL;
}
const DropZone = ({ setAudioSource, audioSourceError, setAudioSourceError }: DropZoneProps) => {
  const [fileRejections, setFileRejections] = useState<FileRejection[]>([]);
  const onDrop = useCallback(
    (acceptedFiles: File[], fileRejections: FileRejection[]) => {
      setFileRejections(fileRejections);
      if (acceptedFiles.length === 0) {
        setAudioSource(undefined);
        setAudioSourceError(true, 'You must select an audio source before uploading');
        return;
      }
      setAudioSourceError(false, '');
      const mappedAccepted = {
        file: acceptedFiles[0],
        preview: Url.createObjectURL(acceptedFiles[0]),
        name: acceptedFiles[0].name.replace(/\.[^/.]+$/, ''),
      };
      setAudioSource({ source: mappedAccepted, type: 'File' });
    },
    [setAudioSource, setAudioSourceError]
  );

  const { getRootProps, getInputProps, isFocused } = useDropzone({
    onDrop,
    validator: fileTypeValidator,
    multiple: false,
  });

  useEffect(() => {
    if (!isFocused) {
      setFileRejections([]);
    }
  }, [isFocused]);

  return (
    <div className={styles.dropzoneContainer}>
      <div
        className={`${styles.dropzone} ${showError(audioSourceError) ? styles.dropzoneError : styles.dropzoneNoError}`}
        {...getRootProps()}
      >
        <input type="hidden" {...getInputProps()} />
        <p>Drag & drop audio files here, or click to select files</p>
      </div>
      {showError(audioSourceError) && <p className={styles.errorMessage}>{getErrorMessage(audioSourceError)}</p>}
      {fileRejections.map((fileRejection) => {
        return (
          <p className={styles.errorMessage} key={fileRejection.file.name}>
            {fileRejection.file.name} - {fileRejection.errors[0].message}
          </p>
        );
      })}
    </div>
  );
};

export default DropZone;
