import { Timestamp } from 'firebase/firestore';

export const SET_LOADING = 'SET_LOADING';
export const LOGOUT = 'LOGOUT';

// User Context
export const GET_USER = 'GET_USER';

export interface userCreditionals {
  email: string;
  password: string;
}
// Sermon

export enum PLAY_STATE {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

export interface PlayedState {
  playPositionMilliseconds: number;
  state: PLAY_STATE;
}

export interface Sermon {
  key: string;
  title: string;
  description: string;
  speaker: Array<string>;
  subtitle: string;
  scripture: string;
  dateMillis: number;
  durationSeconds: number;
  playedState?: PlayedState;
  topic: Array<string>;
  dateString?: string;
}

export interface FirebaseSermon
  extends Omit<Sermon, 'dateMillis' | 'dateString'> {
  date: Timestamp;
}

export interface ListenTimeData {
  listenedAt: Date;
  playedState: PlayedState;
}

// Audio Player Context
export interface SermonWithMetadata extends Sermon {
  playedState: PlayedState;
  url?: string;
}
export type AudioPlayerState = {
  playlist: SermonWithMetadata[];
  currentSermonIndex: number;
  currentSermonSecond: number;
  currentPlayedState: PLAY_STATE;
  playing: boolean;
};
export const AUDIO_PLAYER = {
  SET_PLAYLIST: 'SET_PLAYLIST',
  UPDATE_CURRENT_SECOND: 'UPDATE_CURRENT_SECOND',
  TOGGLE_PLAYING: 'TOGGLE_PLAYING',
  SET_CURRENT_SERMON_INDEX: 'SET_CURRENT_SERMON_INDEX',
  UPDATE_CURRENT_SERMON: 'UPDATE_CURRENT_SERMON',
  SERMON_ENDED: 'SERMON_ENDED',
};
