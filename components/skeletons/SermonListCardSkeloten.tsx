// 'use client';

import Divider from '@mui/material/Divider';
import Card from '@mui/material/Card';
import Skeleton from '@mui/material/Skeleton';
import ListItem from '@mui/material/ListItem';
import Box from '@mui/material/Box';

interface SermonListCardSkelotenProps {
  minimal?: boolean;
}

export default function SermonListCardSkeloten({ minimal = false }: SermonListCardSkelotenProps) {
  return (
    <>
      <Divider />
      <ListItem>
        <Card
          sx={{
            width: 1,
            display: 'grid',
            gridTemplateAreas: {
              xs: `"image title title"
                   "description description description"
                   "playStatus playStatus playStatus"
                   "actionItems actionItems playPause"`,
              sm: `"image title title title"
                   "image description description description"
                   "image playPause playStatus actionItems "`,
            },
            gridTemplateColumns: { xs: 'min-content auto min-content', sm: 'min-content min-content auto min-content' },
            gridColumnGap: '10px',
            padding: 0,
          }}
          elevation={0}
        >
          <Skeleton
            variant="rectangular"
            sx={{
              gridArea: 'image',
              width: { xs: 50, sm: 100, md: 150 },
              height: { xs: 50, sm: 100, md: 150 },
              borderRadius: '5px',
            }}
          />
          <Skeleton
            variant="text"
            sx={{
              gridArea: 'title',
              width: { xs: 200, sm: 250, md: 300 },
              height: { xs: '2rem', sm: '2.25rem', md: '2.5rem' },
            }}
          />
          <Box sx={{ gridArea: 'description' }}>
            <Skeleton
              variant="text"
              sx={{
                marginTop: '5px',
                lineHeight: { xs: 1.1, sm: 1.25, md: 1.5 },
                fontSize: { xs: '0.7rem', sm: '0.9rem', md: '1rem' },
              }}
            />
            <Skeleton
              variant="text"
              sx={{
                lineHeight: { xs: 1.1, sm: 1.25, md: 1.5 },
                fontSize: { xs: '0.7rem', sm: '0.9rem', md: '1rem' },
              }}
            />
          </Box>
          <Box
            display={minimal ? 'none' : 'flex'}
            alignItems="center"
            sx={{ gridArea: 'playStatus', paddingTop: { xs: 1, sm: 0 } }}
          >
            <Skeleton
              variant="text"
              sx={{
                height: { xs: '1rem', sm: '1.25', md: '1.5rem' },
                width: { xs: 100, sm: 125, md: 150 },
              }}
            />
          </Box>
          <Skeleton
            variant="rectangular"
            sx={{ gridArea: 'actionItems', width: 150, height: 30, margin: 1, display: minimal ? 'none' : 'unset' }}
          />
          <Skeleton
            variant="circular"
            sx={{ gridArea: 'playPause', width: 35, height: 35, margin: 1, display: minimal ? 'none' : 'unset' }}
          />
        </Card>
      </ListItem>
    </>
  );
}
