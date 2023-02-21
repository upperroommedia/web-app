// 'use client';

import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
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
        {Array(3)
          .fill(0)
          .map(() => (
            <>
              <Divider variant="middle" />
              <SermonListCardSkeloten />
            </>
          ))}
      </List>
    </Box>
  );
}
