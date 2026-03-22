import Pagination from '@mui/material/Pagination';
import React from 'react';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { usePagination, UsePaginationProps } from 'react-instantsearch';

const CustomPagination = (props: UsePaginationProps) => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const { currentRefinement, nbPages, refine } = usePagination(props);

  return (
    <Pagination
      sx={{
        m: 2,
        '& .MuiPagination-ul': {
          flexWrap: 'nowrap',
        },
      }}
      variant="outlined"
      shape="rounded"
      color="primary"
      boundaryCount={isMobile ? 1 : 1}
      siblingCount={isMobile ? 0 : 1}
      count={nbPages}
      page={currentRefinement + 1}
      onChange={(_, page) => {
        refine(page - 1);
      }}
    />
  );
};

export default CustomPagination;
