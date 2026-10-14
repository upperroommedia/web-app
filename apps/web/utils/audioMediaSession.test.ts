import { connectAudioMediaSession } from './audioMediaSession';

function fixture({ unsupported = false } = {}) {
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  const session = {
    metadata: null as MediaMetadata | null,
    playbackState: 'none' as MediaSessionPlaybackState,
    setPositionState: jest.fn(),
    setActionHandler: jest.fn((action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      if (unsupported && action === 'seekto') throw new Error('unsupported');
      handlers.set(action, handler);
    }),
  };
  let notify = () => {};
  const unsubscribe = jest.fn();
  const player = {
    state: { paused: false, ended: false, currentTime: 15, duration: 120, playbackRate: 1 },
    subscribe: (listener: () => void) => {
      notify = listener;
      return unsubscribe;
    },
  };
  const actions = {
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
    seek: jest.fn().mockResolvedValue(undefined),
  };
  let source = 'first';
  const metadata: MediaMetadata = { title: 'Current sermon', artist: '', album: '', artwork: [] };
  const cleanup = connectAudioMediaSession(session, metadata, player, actions, () => source);
  return {
    session,
    handlers,
    player,
    actions,
    metadata,
    cleanup,
    unsubscribe,
    notify: () => notify(),
    changeSource: () => {
      source = 'second';
    },
  };
}

test('system metadata and hardware controls target the current source with normal seek offsets', () => {
  const f = fixture();
  expect(f.session.metadata).toBe(f.metadata);
  expect(f.session.playbackState).toBe('playing');
  f.handlers.get('play')!({ action: 'play' });
  f.handlers.get('pause')!({ action: 'pause' });
  f.handlers.get('seekforward')!({ action: 'seekforward', seekOffset: 20 });
  f.handlers.get('seekbackward')!({ action: 'seekbackward' });
  f.handlers.get('seekto')!({ action: 'seekto', seekTime: 45 });
  expect(f.actions.play).toHaveBeenCalledTimes(1);
  expect(f.actions.pause).toHaveBeenCalledTimes(1);
  expect(f.actions.seek.mock.calls).toEqual([[35], [5], [45]]);
  expect(f.session.setPositionState).toHaveBeenCalledWith({ duration: 120, position: 15, playbackRate: 1 });
});

test('stale source and disposed hardware handlers cannot control replacement playback', () => {
  const f = fixture();
  const oldPlay = f.handlers.get('play')!;
  const oldSeek = f.handlers.get('seekto')!;
  f.changeSource();
  oldPlay({ action: 'play' });
  oldSeek({ action: 'seekto', seekTime: 50 });
  expect(f.actions.play).not.toHaveBeenCalled();
  expect(f.actions.seek).not.toHaveBeenCalled();
  f.cleanup();
  expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  expect(f.session.metadata).toBeNull();
  expect(f.session.playbackState).toBe('none');
  expect([...f.handlers.values()]).toEqual([null, null, null, null, null]);
  oldPlay({ action: 'play' });
  expect(f.actions.play).not.toHaveBeenCalled();
});

test('native reporting is bounded to whole seconds and tolerates unsupported action and position APIs', () => {
  const f = fixture({ unsupported: true });
  f.session.setPositionState.mockClear();
  f.player.state.currentTime = 15.2;
  f.notify();
  expect(f.session.setPositionState).not.toHaveBeenCalled();
  f.player.state.currentTime = 16.1;
  f.notify();
  expect(f.session.setPositionState).toHaveBeenCalledTimes(1);
  f.player.state.paused = true;
  f.notify();
  expect(f.session.playbackState).toBe('paused');
  f.player.state.duration = Infinity;
  f.notify();
  expect(f.session.setPositionState).toHaveBeenLastCalledWith();
  f.session.setPositionState.mockImplementation(() => {
    throw new Error('unavailable');
  });
  expect(() => f.cleanup()).not.toThrow();
});

test('disposing an older adapter cannot clear a newer session owner', () => {
  const f = fixture();
  const oldPlay = f.handlers.get('play')!;
  const nextMetadata: MediaMetadata = { title: 'Next sermon', artist: '', album: '', artwork: [] };
  const nextCleanup = connectAudioMediaSession(f.session, nextMetadata, f.player, f.actions, () => 'second');
  f.cleanup();
  expect(f.session.metadata).toBe(nextMetadata);
  expect(f.handlers.get('play')).not.toBeNull();
  oldPlay({ action: 'play' });
  expect(f.actions.play).not.toHaveBeenCalled();
  f.handlers.get('play')!({ action: 'play' });
  expect(f.actions.play).toHaveBeenCalledTimes(1);
  nextCleanup();
  expect(f.session.metadata).toBeNull();
});
