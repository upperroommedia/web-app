/**
 * SermonListCard: A component to display sermons in a list
 */
import React, { FunctionComponent, memo } from 'react';
import ListItem from '@mui/material/ListItem';
import Divider from '@mui/material/Divider';
import Card from '@mui/material/Card';
import Typography from '@mui/material/Typography';
import Box from '@mui/system/Box';

import { Sermon, sermonStatusType } from '../types/SermonTypes';

import AdminControls from './SermonCardAdminControls';
import CardActions from '@mui/material/CardActions';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import useMediaQuery from '@mui/material/useMediaQuery';
import useTheme from '@mui/system/useTheme';
import { ErrorBoundary } from 'react-error-boundary';
import ErrorIcon from '@mui/icons-material/Error';

import { useObject } from 'react-firebase-hooks/database';
import database, { ref } from '../firebase/database';
import CircularProgressWithLabel from './CircularProgressWithLabel';
import PlayButton from './PlayButton';
import Tooltip from '@mui/material/Tooltip';

interface Props {
  sermon: Sermon;
  playing: boolean;
  remainingTimeComponent: React.ReactNode;
  trackProgressComponent: React.ReactNode;
  audioPlayerCurrentSermonId: string | undefined;
  audioPlayerSetCurrentSermon: (sermon: Sermon | undefined) => void;
  minimal?: boolean;
  // handleSermonClick: (sermon: Sermon) => void;
}

const SermonListCard: FunctionComponent<Props> = ({
  sermon,
  remainingTimeComponent,
  trackProgressComponent,
  audioPlayerCurrentSermonId,
  audioPlayerSetCurrentSermon,
  minimal,
}: Props) => {
  const theme = useTheme();
  const mdMatches = useMediaQuery(theme.breakpoints.up('md'));
  const smMatches = useMediaQuery(theme.breakpoints.up('sm'));
  const [snapshot, _loading, _error] = useObject(ref(database, `addIntroOutro/${sermon.id}`));

  return (
    <ErrorBoundary fallback={<Box>Error Loading Card</Box>}>
      <Divider />
      <ListItem
      // onClick={(e) => {
      //   e.preventDefault();
      //   // handleSermonClick(sermon);
      // }}
      >
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
          <AvatarWithDefaultImage
            sx={{ gridArea: 'image' }}
            width={mdMatches ? 150 : smMatches ? 100 : 50}
            height={mdMatches ? 150 : smMatches ? 100 : 50}
            altName={sermon.title}
            borderRadius={5}
            image={sermon.images?.find((image) => image.type === 'square')}
          />
          <Box display="flex" alignItems="center" sx={{ gridArea: 'title' }}>
            <Typography variant="h5">
              <Box sx={{ fontWeight: 'bold' }}>{`${sermon.title}: ${sermon.subtitle}`}</Box>
            </Typography>
          </Box>
          <Typography
            sx={{
              gridArea: 'description',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2 /* number of lines to show */,
              WebkitBoxOrient: 'vertical',
              marginTop: '5px',
              lineHeight: { xs: 1.1, sm: 1.25, md: 1.5 },
              fontSize: { xs: '0.7rem', sm: '0.9rem', md: '1rem' },
              fontWeight: 100,
            }}
          >
            {sermon.description}
          </Typography>
          <PlayButton
            minimal={minimal}
            sermon={sermon}
            audioPlayerCurrentSermonId={audioPlayerCurrentSermonId}
            audioPlayerSetCurrentSermon={audioPlayerSetCurrentSermon}
          />

          <Box display="flex" alignItems="center" sx={{ gridArea: 'playStatus', paddingTop: { xs: 1, sm: 0 } }}>
            {!minimal && (
              <Box display="flex" gap={0.2} marginRight={3}>
                <Box display="flex" gap={0.0} flexDirection="column">
                  <Typography sx={{ whiteSpace: 'nowrap', fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' } }}>
                    {`Sermon Date: ${new Date(sermon.dateMillis).toLocaleDateString('en-US', { dateStyle: 'medium' })}`}
                  </Typography>
                  <Typography
                    sx={{ whiteSpace: 'nowrap', color: 'gray', fontSize: { xs: '0.5rem', sm: '0.6rem', md: '.7rem' } }}
                  >
                    {`Uploaded At: ${new Date(sermon.createdAtMillis).toLocaleString('en-US', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}`}
                  </Typography>
                </Box>
                <Typography sx={{ fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' } }}>·</Typography>
                {remainingTimeComponent}
              </Box>
            )}
            {trackProgressComponent}
          </Box>
          <CardActions sx={{ gridArea: 'actionItems', margin: 0, padding: 0 }}>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'end', gap: 0 }}>
                {sermon.status.audioStatus !== sermonStatusType.PROCESSED && (
                  <Box display='flex' gap={1}>
                    <Typography variant="subtitle1" sx={{ margin: 0 }}>
                      {sermon.status.audioStatus}
                    </Typography>
                    {sermon.status.audioStatus === sermonStatusType.ERROR && sermon.status.message && (
                      <Tooltip title={sermon.status.message} placement="top">
                        <ErrorIcon color='error' />
                      </Tooltip>
                    )}
                  </Box>
                )}
                {sermon.status.audioStatus === sermonStatusType.PROCESSING && sermon.status.message && (
                  <Typography
                    sx={{
                      whiteSpace: 'nowrap',
                      color: 'red',
                      fontSize: { xs: '0.5rem', sm: '0.6rem', md: '.7rem' },
                    }}
                  >
                    {sermon.status.message}
                  </Typography>
                )}
                {sermon.status.audioStatus === sermonStatusType.PROCESSING && snapshot !== undefined ? (
                  <CircularProgressWithLabel value={Number(snapshot.val())} />
                ) : (
                  <AdminControls
                    sermon={sermon}
                    audioPlayerCurrentSermonId={audioPlayerCurrentSermonId}
                    audioPlayerSetCurrentSermon={audioPlayerSetCurrentSermon}
                  />
                )}
              </Box>
            </Box>
          </CardActions>
        </Card>
      </ListItem>
    </ErrorBoundary>
  );
};
export default memo(SermonListCard);
