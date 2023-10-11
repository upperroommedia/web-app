import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useSearchBox, UseSearchBoxProps, useStats } from 'react-instantsearch';

const CustomSearchBox = (props: UseSearchBoxProps) => {
  const { refine } = useSearchBox(props);
  const { nbHits, processingTimeMS } = useStats();
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
      />
      <Typography
        variant="subtitle1"
        sx={{ paddingX: 1, fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.85rem' } }}
      >{`${nbHits} ${nbHits === 1 ? 'result' : 'results'} found in ${processingTimeMS}ms`}</Typography>
    </Stack>
  );
};

export default CustomSearchBox;
