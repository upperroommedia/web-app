interface SessionPlayer {
  readonly state: {
    readonly paused: boolean;
    readonly ended: boolean;
    readonly currentTime: number;
    readonly duration: number;
    readonly playbackRate: number;
  };
  subscribe: (callback: () => void) => () => void;
}
interface SessionActions {
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => Promise<void>;
}
type NativeSession = Pick<MediaSession, 'metadata' | 'playbackState' | 'setActionHandler'> &
  Partial<Pick<MediaSession, 'setPositionState'>>;

const sessionOwners = new WeakMap<object, symbol>();

// Video.js 10 does not supply Media Session metadata. Own only this player's
// handlers, never allow an old source's retained OS handler to command a new one.
export function connectAudioMediaSession(
  session: NativeSession,
  metadata: MediaMetadata | null,
  player: SessionPlayer,
  actions: SessionActions,
  getSource: () => string
) {
  const source = getSource();
  const owner = Symbol('audio-session');
  sessionOwners.set(session, owner);
  const ownsSession = () => sessionOwners.get(session) === owner;
  let connected = true;
  const current = () => connected && ownsSession() && getSource() === source;
  const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
    play: () => {
      if (current()) void actions.play();
    },
    pause: () => {
      if (current()) actions.pause();
    },
    seekbackward: (details) => {
      if (current()) void actions.seek(player.state.currentTime - (details.seekOffset ?? 10));
    },
    seekforward: (details) => {
      if (current()) void actions.seek(player.state.currentTime + (details.seekOffset ?? 10));
    },
    seekto: (details) => {
      if (current() && Number.isFinite(details.seekTime)) void actions.seek(details.seekTime!);
    },
  };
  const installed: MediaSessionAction[] = [];
  session.metadata = metadata;
  for (const action of Object.keys(handlers) as MediaSessionAction[]) {
    try {
      session.setActionHandler(action, handlers[action]!);
      installed.push(action);
    } catch {
      // Media Session implementations may support only a subset of actions.
    }
  }
  let lastPosition = '';
  const update = () => {
    if (!current()) return;
    const { paused, ended, duration, currentTime, playbackRate } = player.state;
    const playbackState = paused || ended ? 'paused' : 'playing';
    if (session.playbackState !== playbackState) session.playbackState = playbackState;
    if (!session.setPositionState) return;
    if (!(duration > 0) || !Number.isFinite(duration) || !(playbackRate > 0) || !Number.isFinite(playbackRate)) {
      if (lastPosition) {
        try {
          session.setPositionState();
        } catch {}
      }
      lastPosition = '';
      return;
    }
    const position = Math.max(0, Math.min(duration, Number.isFinite(currentTime) ? currentTime : 0));
    const signature = `${Math.floor(position)}:${duration}:${playbackRate}`;
    if (signature === lastPosition) return;
    try {
      session.setPositionState({ duration, playbackRate, position });
      lastPosition = signature;
    } catch {
      // Unsupported native position reporting must not interrupt playback.
    }
  };
  update();
  const unsubscribe = player.subscribe(update);
  return () => {
    connected = false;
    unsubscribe();
    if (!ownsSession()) return;
    sessionOwners.delete(session);
    for (const action of installed) {
      try {
        session.setActionHandler(action, null);
      } catch {}
    }
    session.metadata = null;
    session.playbackState = 'none';
    try {
      session.setPositionState?.();
    } catch {}
  };
}
