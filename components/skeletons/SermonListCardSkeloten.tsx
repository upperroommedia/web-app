// 'use client';

import Divider from '@mui/material/Divider';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Skeleton from '@mui/material/Skeleton';
import ListItem from '@mui/material/ListItem';

export default function SermonListCardSkeloten() {
  return (
    <ListItem>
      <Divider variant="middle" />
      <Card sx={{ width: '100%', display: 'flex', gap: 3, padding: 2 }} elevation={0}>
        <Skeleton variant="rectangular" width={150} height={150} sx={{ flex: 'none', borderRadius: '5px' }} />
        <Box display={'flex'} flexDirection="column" justifyContent="space-between" width={1}>
          <Box padding={0}>
            <Skeleton variant="text" width={300} sx={{ fontSize: '1.75rem', borderRadius: '5px' }} />
            <Skeleton variant="text" width={500} sx={{ fontSize: '1.25rem', borderRadius: '5px' }} />
          </Box>
          {Math.random() > 0.5 && (
            <Box width="100%">
              <Skeleton variant="text" width="100%" sx={{ fontSize: '0.5rem', borderRadius: '5px' }} />
              <Skeleton variant="text" width="80%" sx={{ fontSize: '0.5rem', borderRadius: '5px' }} />
            </Box>
          )}

          {/* <Box bgcolor="red" flexGrow="1" /> */}
          <Box display={'flex'} marginLeft={3} alignItems={'center'}>
            <Skeleton variant="circular" width={50} height={50} />
            <Skeleton variant="text" width={100} sx={{ fontSize: '1rem', marginLeft: 3, borderRadius: '5px' }} />
          </Box>
        </Box>
        <Divider />
      </Card>
    </ListItem>
  );
}
