import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import FormLabel from '@mui/material/FormLabel';
import Skeleton from '@mui/material/Skeleton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Box from '@mui/system/Box';
import { useInstantSearch, useRefinementList, UseRefinementListProps } from 'react-instantsearch';

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
  const { status, results } = useInstantSearch();
  const { items, refine, searchForItems, canToggleShowMore, isShowingMore, toggleShowMore } = useRefinementList(props);
  const skeletonRows = props.attribute === 'speakers.name' ? 5 : 2;
  const showSkeleton = results.__isArtificial || (items.length === 0 && (status === 'loading' || status === 'stalled'));

  if (showSkeleton) {
    return (
      <FormGroup sx={{ width: '100%', gap: 0.375 }}>
        <FormLabel>{props.title}</FormLabel>
        {props.searchable && <Skeleton variant="rectangular" height={40} width="100%" sx={{ borderRadius: 0.75 }} />}
        {Array.from({ length: skeletonRows }).map((_, index) => (
          <Box
            key={`${props.attribute}-skeleton-${index}`}
            display="flex"
            alignItems="flex-start"
            gap={1}
            sx={{ py: 0.125, width: '100%', minWidth: 0 }}
          >
            <Skeleton variant="rectangular" width={20} height={20} sx={{ borderRadius: '3px', mt: '2px', mb: '2px' }} />
            <Box display="flex" alignItems="flex-start" gap={1} width="100%" minWidth={0}>
              <Skeleton variant="text" width={index % 2 === 0 ? 112 : 148} sx={{ fontSize: '1rem', lineHeight: 1.5 }} />
              <Box sx={{ flex: 1, minWidth: 0 }} />
              <Skeleton variant="rectangular" width={34} height="1.5rem" sx={{ borderRadius: 0.5, flexShrink: 0 }} />
            </Box>
          </Box>
        ))}
        {props.searchable && <Skeleton variant="text" width={68} height={22} sx={{ mt: 0.25, alignSelf: 'center' }} />}
      </FormGroup>
    );
  }

  return (
    <FormGroup sx={{ width: '100%', gap: 0.375 }}>
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
          sx={{
            py: 0.125,
            pl: 0,
            pr: 0,
            mr: 0,
            ml: 0,
            width: '100%',
            alignItems: 'flex-start',
            columnGap: 1,
            '& .MuiFormControlLabel-label': {
              flex: 1,
              minWidth: 0,
            },
          }}
          key={String(item.value)}
          control={
            <Checkbox
              checked={item.isRefined}
              disableRipple
              size="small"
              onChange={() => refine(item.value)}
              sx={{
                p: 0,
                mt: '2px',
                mr: 0,
                flexShrink: 0,
                alignSelf: 'flex-start',
              }}
            />
          }
          label={
            <Box display="flex" alignItems="flex-start" gap={1} width="100%" minWidth={0}>
              <Typography
                sx={{
                  flex: 1,
                  minWidth: 0,
                  whiteSpace: 'normal',
                  overflowWrap: 'anywhere',
                  lineHeight: 1.3,
                }}
              >
                {normalizeLabel(item.label)}
              </Typography>
              <Chip label={item.count} size="small" sx={{ flexShrink: 0 }} />
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
