import { createAudioPlaybackActions, AudioPlaybackStore } from './audioPlaybackActions';

function fixture() {
  const player = {
    target: {},
    state: { paused: true, duration: 120 },
    play: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    pause: jest.fn<void, []>(),
    seek: jest.fn<Promise<number>, [number]>().mockImplementation(async (seconds) => seconds),
  } satisfies AudioPlaybackStore;
  const report = jest.fn();
  let source = 'first';
  const actions = createAudioPlaybackActions(player, () => source, report);
  return {
    player,
    report,
    actions,
    changeSource: () => {
      source = 'second';
    },
  };
}

test('toggle reads current playback state, and seek clamps without dispatching unknown-duration requests', async () => {
  const f = fixture();
  f.actions.togglePaused();
  expect(f.player.play).toHaveBeenCalledTimes(1);
  f.player.state.paused = false;
  f.actions.togglePaused();
  expect(f.player.pause).toHaveBeenCalledTimes(1);
  await f.actions.seek(-3);
  await f.actions.seek(500);
  expect(f.player.seek.mock.calls).toEqual([[0], [120]]);
  f.player.state.duration = 0;
  await f.actions.seek(5);
  await f.actions.seek(NaN);
  expect(f.player.seek).toHaveBeenCalledTimes(2);
});

test('blocked playback and current seek errors report a recoverable message rather than rejecting unhandled', async () => {
  const f = fixture();
  f.player.play.mockRejectedValue(new Error('NotAllowedError'));
  await expect(f.actions.play()).resolves.toBeUndefined();
  expect(f.report).toHaveBeenLastCalledWith('Audio could not start. Select Play to try again.');
  f.player.seek.mockRejectedValue(new Error('seek failed'));
  await expect(f.actions.seek(10)).resolves.toBeUndefined();
  expect(f.report).toHaveBeenLastCalledWith('Audio could not seek. Please try again.');
});

test.each(['source', 'target', 'abort'])(
  'stale %s play response cannot overwrite current player feedback',
  async (kind) => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.player.play.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    const pending = f.actions.play();
    if (kind === 'source') f.changeSource();
    if (kind === 'target') f.player.target = {};
    reject(Object.assign(new Error('late response'), { name: kind === 'abort' ? 'AbortError' : 'Error' }));
    await pending;
    expect(f.report.mock.calls).toEqual([[undefined]]);
  }
);

test('same-element source replacement invalidates a pending seek failure', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.player.seek.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      })
  );
  const pending = f.actions.seek(12);
  f.changeSource();
  reject(new Error('old source'));
  await pending;
  expect(f.report).not.toHaveBeenCalled();
});
