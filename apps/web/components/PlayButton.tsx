import React from 'react';
import { Sermon, sermonStatusType } from '../types/SermonTypes';
import { usePlayer } from '@videojs/react/audio';
import { usePlaybackActions, usePlaybackPlaying, usePlaybackFeedback } from '../context/audio/audioPlayback';
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
  const { ready, error } = usePlaybackFeedback();

  const remote = usePlaybackActions();
  const waiting = usePlayer((state) => state.waiting);
  const playing = usePlaybackPlaying();

  const isLoadingPlayback = sermon.id === audioPlayerCurrentSermonId && !error && (waiting || !ready);

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
