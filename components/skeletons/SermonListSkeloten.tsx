// 'use client';

import Box from '@mui/material/Box';
import List from '@mui/material/List';
import { memo } from 'react';
import SermonListCardSkeloten from './SermonListCardSkeloten';

interface SermonsListSkelotenProps {
  minimal?: boolean;
  count?: number;
}
export default memo(function SermonListSkeloten({ minimal, count }: SermonsListSkelotenProps) {
  console.log('SermonsListSkeloten');
  return (
    <Box display="flex" justifyContent={'start'} width={1}>
      <List
        sx={{
          maxWidth: '1200px',
          width: 1,
        }}

        // bgcolor={'blue'}
      >
        {Array.from(Array(count || 3).keys()).map((i) => (
          <SermonListCardSkeloten minimal={minimal} key={`sermonListCardSkeloten: ${i}`} />
        ))}
      </List>
    </Box>
  );
});
