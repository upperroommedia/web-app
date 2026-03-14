import { ReactElement } from 'react';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useInstantSearch, useSearchBox, UseSearchBoxProps, useStats } from 'react-instantsearch';

const CustomSearchBox = (props: UseSearchBoxProps & { TextFieldEndAdornment?: ReactElement }) => {
  const { TextFieldEndAdornment, ...searchBoxProps } = props;
  const { refine } = useSearchBox(searchBoxProps);
  const { nbHits } = useStats();
  const { status, results } = useInstantSearch();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const hasSettledResults = !results.__isArtificial && status === 'idle';
  const isLoadingState = !hasSettledResults && (results.__isArtificial || status === 'stalled' || status === 'loading');
  
  const placeholder = isMobile 
    ? 'Search sermons...' 
    : 'Search for a sermon by name, subtitle, speaker, or description';

  return (
    <Stack
      sx={{
        pt: { xs: 0.5, sm: 1 },
        px: { xs: 0, sm: 1 },
        maxWidth: '1200px',
        width: 1,
      }}
    >
      <TextField
        fullWidth
        type="search"
        placeholder={placeholder}
        size={isMobile ? 'small' : 'medium'}
        onChange={async (e) => {
          refine(e.target.value);
        }}
        InputProps={TextFieldEndAdornment ? { endAdornment: TextFieldEndAdornment } : {}}
      />
      <Typography 
        variant="subtitle1" 
        sx={{ 
          px: { xs: 0.5, sm: 1 }, 
          fontSize: { xs: '0.65rem', sm: '0.75rem', md: '0.8rem' },
          color: status === 'error' ? 'error.dark' : 'text.secondary',
        }}
      >
        {status === 'error'
          ? 'Error'
          : isLoadingState
            ? 'Loading...'
            : `${nbHits} ${nbHits === 1 ? 'result' : 'results'} found`}
      </Typography>
    </Stack>
  );
};

export default CustomSearchBox;
