import Pagination from '@mui/material/Pagination';
import React from 'react';
import { usePagination, UsePaginationProps } from 'react-instantsearch';

const CustomPagination = (props: UsePaginationProps) => {
  const { currentRefinement, nbPages, refine } = usePagination(props);

  return (
    <Pagination
      sx={{ m: 2 }}
      variant="outlined"
      shape="rounded"
      color="primary"
      count={nbPages}
      page={currentRefinement + 1}
      onChange={(_, page) => {
        refine(page - 1);
      }}
    />
  );
};

export default CustomPagination;
