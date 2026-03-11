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
import { useEffect, useMemo, useState } from 'react';

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
  props: UseRefinementListProps & { title: string; searchable?: boolean; searchablePlaceholder?: string; }
) => {
  const { status, results } = useInstantSearch();
  const { items, refine, searchForItems, canToggleShowMore, isShowingMore, toggleShowMore } = useRefinementList(props);
  const [stableItems, setStableItems] = useState(items);

  useEffect(() => {
    if (items.length > 0) {
      queueMicrotask(() => {
        setStableItems(items);
      });
    }
  }, [items]);

  const renderedItems = useMemo(() => (items.length > 0 ? items : stableItems), [items, stableItems]);
  const skeletonRows = props.attribute === 'speakers.name' ? 5 : 2;
  const showSkeleton = results.__isArtificial || (renderedItems.length === 0 && (status === 'loading' || status === 'stalled'));

  if (showSkeleton) {
    return (
      <FormGroup sx={{ width: '100%' }}>
        <FormLabel>{props.title}</FormLabel>
        {props.searchable && (
          <Skeleton variant="rectangular" height={40} width="100%" sx={{ borderRadius: 0.75 }} />
        )}
        {Array.from({ length: skeletonRows }).map((_, index) => (
          <Box
            key={`${props.attribute}-skeleton-${index}`}
            display="flex"
            alignItems="center"
            gap={1}
            sx={{ py: 0.125 }}
          >
            <Skeleton variant="rectangular" width={20} height={20} sx={{ borderRadius: '3px', mt: '2px', mb: '2px' }} />
            <Skeleton variant="text" width={index % 2 === 0 ? '40%' : '50%'} sx={{ fontSize: '1rem', lineHeight: 1.5 }} />
            <Skeleton variant="rectangular" width={34} height='1.5rem' sx={{ borderRadius: 0.5 }} />
          </Box>
        ))}
        {props.searchable && <Skeleton variant="text" width={68} height={22} sx={{ mt: 0.25, alignSelf: 'center' }} />}
      </FormGroup>
    );
  }

  return (
    <FormGroup sx={{ width: '100%' }}>
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
      {renderedItems.map((item, index) => (
        <FormControlLabel
          sx={{ py: 0, pl: 1 }}
          key={`${String(item.value)}-${index}`}
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
