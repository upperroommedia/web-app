import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import FormLabel from '@mui/material/FormLabel';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Box from '@mui/system/Box';
import { useRefinementList, UseRefinementListProps } from 'react-instantsearch';

const normalizeLabel = (label: string) => {
  return label
    .split(/[ _]/)
    .map((word) => {
      const lowercase = word.toLowerCase();
      return lowercase.charAt(0).toUpperCase() + lowercase.slice(1);
    })
    .join(' ');
};
const CustomRefinementList = (
  props: UseRefinementListProps & { title: string; searchable?: boolean; searchablePlaceholder?: string }
) => {
  const { items, refine, searchForItems, canToggleShowMore, isShowingMore, toggleShowMore } = useRefinementList(props);
  return (
    <FormGroup>
      <FormLabel>{props.title}</FormLabel>
      {/* Add MUI search for searchForItems */}
      {props.searchable && (
        <TextField
          fullWidth
          sx={{ m: 0, p: 0 }}
          placeholder={props.searchablePlaceholder}
          size="small"
          type="search"
          onChange={(e) => searchForItems(e.currentTarget.value)}
        />
      )}
      {items.map((item) => (
        <FormControlLabel
          sx={{ py: 0, pl: 1 }}
          key={item.label}
          control={<Checkbox sx={{ p: 0 }} disableRipple onChange={() => refine(item.value)} />}
          label={
            <Box display="flex" alignItems="baseline" gap={1}>
              <Typography noWrap>{normalizeLabel(item.label)}</Typography>
              <Chip label={item.count} size="small" />
            </Box>
          }
        />
      ))}
      {/* Add small MUI button for showMore */}
      {canToggleShowMore && (
        <Button disableRipple size="small" type="button" onClick={toggleShowMore} aria-label="Show more">
          {isShowingMore ? 'Show less' : 'Show more'}
        </Button>
      )}
    </FormGroup>
  );
};

export default CustomRefinementList;
