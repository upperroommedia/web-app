import { useCallback, useEffect, useState } from 'react';
import { FileRejection, useDropzone } from 'react-dropzone';
import styles from '../styles/DropZone.module.css';
export interface UploadableFile {
  file: File;
  name: string;
  preview: string;
}

interface DropZoneProps {
  setFile: (file: UploadableFile | undefined) => void;
}

function fileTypeValidator(file: File) {
  // reject any files over 500mb
  if (!file.type.includes('audio/')) return { code: 'file-type', message: 'File must be an audio file' };
  if (file.size > 300000000) {
    return { code: 'file-size', message: 'File size too large - 300mb max' };
  }
  return null;
}

let Url: any;
if (typeof window !== 'undefined') {
  Url = window.URL || window.webkitURL;
}
const DropZone = ({ setFile }: DropZoneProps) => {
  const [fileRejections, setFileRejections] = useState<FileRejection[]>([]);
  const onDrop = useCallback((acceptedFiles: File[], fileRejections: FileRejection[]) => {
    setFileRejections(fileRejections);
    if (acceptedFiles.length === 0) {
      setFile(undefined);
      return;
    }
    const mappedAccepted = {
      file: acceptedFiles[0],
      preview: Url.createObjectURL(acceptedFiles[0]),
      name: acceptedFiles[0].name.replace(/\.[^/.]+$/, ''),
    };
    setFile(mappedAccepted);
  }, []);

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
      <div className={styles.dropzone} {...getRootProps()}>
        <input type="hidden" {...getInputProps()} />
        <p>Drag & drop audio files here, or click to select files</p>
      </div>
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
