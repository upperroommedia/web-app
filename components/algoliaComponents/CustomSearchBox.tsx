import TextField from '@mui/material/TextField';
import { useSearchBox, UseSearchBoxProps } from 'react-instantsearch';

const CustomSearchBox = (props: UseSearchBoxProps) => {
  const { refine } = useSearchBox(props);
  // const { status } = useInstantSearch();
  return (
    <TextField
      sx={{
        paddingX: 2,
        maxWidth: '1200px',
        width: 1,
      }}
      fullWidth
      type="search"
      placeholder="Search a for a sermon by name, subtitle, speaker, or description"
      onChange={async (e) => {
        refine(e.target.value);
      }}
    />
  );
};

export default CustomSearchBox;
