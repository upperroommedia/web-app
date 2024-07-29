import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useInstantSearch, useSearchBox, UseSearchBoxProps, useStats } from 'react-instantsearch';

const CustomSearchBox = (props: UseSearchBoxProps & { TextFieldEndAdornment?: React.ReactElement }) => {
  const { refine } = useSearchBox(props);
  const { nbHits, processingTimeMS } = useStats();
  const { status } = useInstantSearch();
  // const { status } = useInstantSearch();
  return (
    <Stack
      sx={{
        paddingTop: 2,
        paddingX: 2,
        maxWidth: '1200px',
        width: 1,
      }}
    >
      <TextField
        fullWidth
        type="search"
        placeholder="Search a for a sermon by name, subtitle, speaker, or description"
        onChange={async (e) => {
          refine(e.target.value);
        }}
        InputProps={props.TextFieldEndAdornment ? { endAdornment: props.TextFieldEndAdornment } : {}}
      />
      {status === 'error' ? (
        <Typography
          variant="subtitle1"
          sx={{ color: 'error.dark', paddingX: 1, fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.85rem' } }}
        >
          Error
        </Typography>
      ) : (
        <Typography variant="subtitle1" sx={{ paddingX: 1, fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.85rem' } }}>
          {status === 'stalled' || status === 'loading'
            ? 'Loading...'
            : `${nbHits} ${nbHits === 1 ? 'result' : 'results'} found in ${processingTimeMS}ms`}
        </Typography>
      )}
    </Stack>
  );
};

export default CustomSearchBox;
