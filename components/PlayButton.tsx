import React, { useState } from 'react';
import { Sermon, sermonStatusType } from '../types/SermonTypes';
import { useMediaRemote, useMediaState } from '@vidstack/react';
import IconButton from '@mui/material/IconButton';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import PauseCircleIcon from '@mui/icons-material/PauseCircle';
import CircularProgress from '@mui/material/CircularProgress';

interface PlayButtonProps {
  minimal: boolean | undefined;
  audioPlayerCurrentSermonId: string | undefined;
  audioPlayerSetCurrentSermon: (sermon: Sermon | undefined) => void;
  sermon: Sermon;
}

export default function PlayButton({
  minimal,
  sermon,
  audioPlayerCurrentSermonId,
  audioPlayerSetCurrentSermon,
}: PlayButtonProps) {
  const [srcLoading, setSrcLoading] = useState(false);

  const remote = useMediaRemote();
  const waiting = useMediaState('waiting');
  const playing = useMediaState('playing');

  const isLoadingPlayback = waiting || (srcLoading && !playing && sermon.id === audioPlayerCurrentSermonId);

  return (
    <>
      {!minimal && sermon.status.audioStatus === sermonStatusType.PROCESSED && (
        <IconButton
          sx={{ gridArea: 'playPause', flexShrink: 0, alignSelf: 'center' }}
          aria-label="toggle play/pause"
          onClick={(e) => {
            e.preventDefault();
            if (audioPlayerCurrentSermonId !== sermon.id) {
              audioPlayerSetCurrentSermon(sermon);
              setSrcLoading(true);
            } else {
              remote.togglePaused();
            }
          }}
        >
          {sermon.id !== audioPlayerCurrentSermonId ? (
            <PlayCircleIcon fontSize="large" />
          ) : isLoadingPlayback ? (
            <CircularProgress color="inherit" size={35} />
          ) : playing ? (
            <PauseCircleIcon fontSize="large" />
          ) : (
            <PlayCircleIcon fontSize="large" />
          )}
        </IconButton>
      )}
    </>
  );
}
