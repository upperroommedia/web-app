import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import { Dispatch, FunctionComponent, SetStateAction, useState } from 'react';
import Button from '@mui/material/Button';
import { UploadableFile } from './DropZone';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';

interface YoutubeUrlToMp3Props {
  setFile: Dispatch<SetStateAction<UploadableFile | undefined>>;
}

async function convertToMp3(url: string, setError: Dispatch<SetStateAction<string>>) {
  console.log(url);
  try {
    const response = await fetch(`https://youtube-to-mp-3-cloud-run-yshbijirxq-uc.a.run.app/?url=${url}`, {
      method: 'GET',
      headers: {
        responseType: 'blob',
        // Accept: 'application/force-download',
      },
    });
    if (!response.ok) {
      throw new Error('There was an error converting the input url');
    }
    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const uploadableFile: UploadableFile = {
      file: new File([blob], 'youtubeMp3.mp3'),
      name: 'youtubeMp3.mp3',
      preview: downloadUrl,
    };
    return uploadableFile;
  } catch (err) {
    if (err instanceof Error) {
      setError(err.message);
    }
  }
}

const YoutubeUrlToMp3: FunctionComponent<YoutubeUrlToMp3Props> = ({ setFile }: YoutubeUrlToMp3Props) => {
  const [inputText, setInputText] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  return (
    <Box display="flex" width={1} flexDirection="column" justifyContent="center" alignItems="center">
      <Box display="flex" width={1} justifyContent="center" alignItems="center" gap={1}>
        <TextField
          sx={{
            display: 'block',
            width: 1,
          }}
          fullWidth
          id="youtube-url-input"
          label="Youtube Link"
          name="Youtube Link"
          variant="outlined"
          required
          value={inputText}
          disabled={isLoading}
          onChange={(e) => {
            setInputText(e.target.value);
            if (error) {
              setError('');
            }
          }}
        />
        <Button
          variant="contained"
          disabled={isLoading}
          onClick={async () => {
            setIsLoading(true);
            const uploadableFile = await convertToMp3(inputText, setError);
            setIsLoading(false);
            setFile(uploadableFile);
          }}
        >
          {isLoading ? <CircularProgress size={24} /> : 'Convert'}
        </Button>
      </Box>
      {error && (
        <Typography variant="caption" color="red">
          {error}
        </Typography>
      )}
    </Box>
  );
};

export default YoutubeUrlToMp3;