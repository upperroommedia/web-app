import Pagination from '@mui/material/Pagination';
import React from 'react';
import { usePagination, UsePaginationProps } from 'react-instantsearch';

const CustomPagination = (props: UsePaginationProps) => {
  const { nbPages, refine } = usePagination(props);

  return (
    <Pagination
      variant="outlined"
      shape="rounded"
      color="primary"
      count={nbPages}
      onChange={(_, page) => refine(page - 1)}
    />
  );
};

export default CustomPagination;
