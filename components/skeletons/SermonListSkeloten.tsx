// 'use client';

import Box from '@mui/material/Box';
import List from '@mui/material/List';
import SermonListCardSkeloten from './SermonListCardSkeloten';

export default function SermonListSkeloten() {
  return (
    <Box display="flex" justifyContent={'start'} width={1}>
      <List
        sx={{
          maxWidth: '1200px',
          width: 1,
        }}

        // bgcolor={'blue'}
      >
        {[1, 2, 3].map((i) => (
          <SermonListCardSkeloten key={`sermonListCardSkeloten: ${i}`} />
        ))}
      </List>
    </Box>
  );
}
