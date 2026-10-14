import { AudioSourceOwnership } from './audioSourceOwnership';
const file = (name = 'recording.wav') => new File(['sound'], name);
function setup() {
  let id = 0;
  const urls = { createObjectURL: jest.fn(() => `blob:owned-${++id}`), revokeObjectURL: jest.fn() };
  const owner = new AudioSourceOwnership(urls);
  return { owner, urls };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
it('revokes replaced selections immediately even when React never commits intermediate renders', () => {
  const { owner, urls } = setup();
  owner.select(file());
  owner.select(file());
  owner.select(file());
  expect(urls.revokeObjectURL.mock.calls).toEqual([['blob:owned-1'], ['blob:owned-2']]);
  expect(owner.source?.type === 'File' && owner.source.source.preview).toBe('blob:owned-3');
});
it('releases the current source when a rejected selection clears it', () => {
  const { owner, urls } = setup();
  owner.select(file());
  owner.select(undefined);
  expect(urls.revokeObjectURL).toHaveBeenCalledTimes(1);
  expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:owned-1');
  expect(owner.source).toBeUndefined();
});
it('does not revoke the current URL during StrictMode cleanup/setup replay', () => {
  const { owner, urls } = setup();
  owner.activate();
  owner.select(file());
  owner.deactivate();
  owner.activate();
  jest.runOnlyPendingTimers();
  expect(urls.revokeObjectURL).not.toHaveBeenCalled();
  expect(owner.source?.type).toBe('File');
  owner.deactivate();
  jest.runOnlyPendingTimers();
  expect(urls.revokeObjectURL).toHaveBeenCalledTimes(1);
  expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:owned-1');
  expect(owner.source).toBeUndefined();
});
it('releases all URLs on unmount, including a selection arriving before deferred disposal', () => {
  const { owner, urls } = setup();
  owner.select(file());
  owner.deactivate();
  owner.select(file());
  jest.runOnlyPendingTimers();
  expect(urls.revokeObjectURL.mock.calls).toEqual([['blob:owned-1'], ['blob:owned-2']]);
  owner.select(file());
  expect(urls.createObjectURL).toHaveBeenCalledTimes(2);
});
it('replacing with the same source does not revoke it, and clearing twice releases once', () => {
  const { owner, urls } = setup();
  const source = owner.select(file());
  owner.replace(source);
  owner.replace(undefined);
  owner.replace(undefined);
  expect(urls.revokeObjectURL).toHaveBeenCalledTimes(1);
});
it('releases a local preview when a URL source replaces it without touching its File content', async () => {
  const { owner, urls } = setup();
  const selected = file();
  owner.select(selected);
  owner.replace({ type: 'YoutubeUrl', source: 'https://youtube.example/video' });
  expect(urls.revokeObjectURL).toHaveBeenCalledTimes(1);
  expect(await selected.text()).toBe('sound');
});
