import { applySpeakerImageDefaults, loadSpeakerImageDefaults } from './speakerImageDefaults';
import { createEmptySermon } from '../types/Sermon';
import type { ImageType, ImageSizeType } from '../types/Image';
import type { ISpeaker } from '../types/Speaker';

const image = (id: string, type: ImageSizeType = 'square'): ImageType => ({
  id,
  type,
  size: 'original',
  width: 100,
  height: 100,
  name: id,
  downloadLink: `https://example.test/${id}`,
  dateAddedMillis: 1,
});
const speaker: ISpeaker = { id: 'speaker', name: 'Speaker', images: [], sermonCount: 0 };
const sermon = () => ({ ...createEmptySermon('uploader'), speakers: [speaker] });

test('stale embedded default never becomes a selected image when its canonical document is absent', async () => {
  const read = jest.fn(async () => undefined);
  const result = await loadSpeakerImageDefaults([image('legacy-default')], [], read);
  expect(read).toHaveBeenCalledWith('legacy-default');
  expect(result).toEqual({ images: [], unavailable: true });
});
test('uses canonical snapshot identity and metadata rather than embedded URLs/provider IDs', async () => {
  const canonical = { ...image('stored-id'), name: 'Current canonical image', subsplashId: 'verified-provider' };
  const result = await loadSpeakerImageDefaults(
    [{ ...image('canonical'), downloadLink: 'https://stale.invalid/image', subsplashId: 'stale-provider' }],
    [],
    async () => ({ id: 'canonical', data: canonical })
  );
  expect(result).toEqual({ images: [{ ...canonical, id: 'canonical' }], unavailable: false });
});
test('reads only missing supported aspect slots and deduplicates IDs before fetching', async () => {
  const read = jest.fn(async (id: string) => ({ id, data: image(id, 'wide') }));
  const result = await loadSpeakerImageDefaults(
    [image('occupied'), image('same', 'wide'), image('same', 'banner'), image('extra', 'wide')],
    [image('manual')],
    read
  );
  expect(read.mock.calls).toEqual([['same']]);
  expect(result).toEqual({ images: [image('same', 'wide')], unavailable: true });
});
test('handles rejected, malformed and mismatched canonical records without discarding another valid default', async () => {
  const result = await loadSpeakerImageDefaults(
    [image('missing'), image('good', 'wide'), image('broken', 'banner')],
    [],
    async (id) => {
      if (id === 'missing') throw new Error('offline');
      if (id === 'broken') return { id, data: { ...image(id, 'banner'), width: 0 } };
      return { id, data: image(id, 'wide') };
    }
  );
  expect(result).toEqual({ images: [image('good', 'wide')], unavailable: true });
  expect(
    await loadSpeakerImageDefaults([image('one')], [], async () => ({ id: 'other', data: image('other') }))
  ).toEqual({ images: [], unavailable: true });
});
test('invalid embedded IDs do not cause reads or URL-based image synthesis', async () => {
  const read = jest.fn(async () => undefined);
  expect(await loadSpeakerImageDefaults([image('bad/path')], [], read)).toEqual({ images: [], unavailable: true });
  expect(await loadSpeakerImageDefaults([image(' ')], [], read)).toEqual({ images: [], unavailable: true });
  expect(read).not.toHaveBeenCalled();
});
test('all three aspect reads start independently and remain bounded', async () => {
  const ids = ['square', 'wide', 'banner'] as const;
  const releases: Array<() => void> = [];
  const read = jest.fn(
    (id: string) =>
      new Promise<{ id: string; data: ImageType }>((resolve) => {
        releases.push(() => resolve({ id, data: image(id, id as ImageSizeType) }));
      })
  );
  const pending = loadSpeakerImageDefaults(
    ids.map((id) => image(id, id)),
    [],
    read
  );
  expect(read.mock.calls.map(([id]) => id)).toEqual(ids);
  releases.forEach((release) => release());
  expect((await pending).images).toHaveLength(3);
});
test('applies canonical defaults only to the same unchanged current single-speaker selection', () => {
  const current = sermon();
  const context = {
    speakerId: speaker.id,
    imagesAtSelection: current.images,
    selection: 1,
    currentSelection: 1,
    mounted: true,
  };
  expect(applySpeakerImageDefaults(current, [image('canonical')], context).images).toEqual([image('canonical')]);
  for (const changed of [{ currentSelection: 2 }, { mounted: false }, { speakerId: 'other' }])
    expect(applySpeakerImageDefaults(current, [image('canonical')], { ...context, ...changed })).toBe(current);
  const clearedSpeaker = { ...current, speakers: [] };
  expect(applySpeakerImageDefaults(clearedSpeaker, [image('canonical')], context)).toBe(clearedSpeaker);
});
test('late defaults never overwrite manual selection or a manual add-then-clear', () => {
  const initial = sermon();
  const context = {
    speakerId: speaker.id,
    imagesAtSelection: initial.images,
    selection: 1,
    currentSelection: 1,
    mounted: true,
  };
  const manuallySelected = { ...initial, images: [image('manual')] };
  const manuallyCleared = { ...initial, images: [] };
  expect(applySpeakerImageDefaults(manuallySelected, [image('default')], context)).toBe(manuallySelected);
  expect(applySpeakerImageDefaults(manuallyCleared, [image('default')], context)).toBe(manuallyCleared);
});
test('preserves existing manual images while filling only an empty aspect slot', () => {
  const current = { ...sermon(), images: [image('manual')] };
  expect(
    applySpeakerImageDefaults(current, [image('default'), image('wide', 'wide')], {
      speakerId: speaker.id,
      imagesAtSelection: current.images,
      selection: 1,
      currentSelection: 1,
      mounted: true,
    }).images
  ).toEqual([image('manual'), image('wide', 'wide')]);
});
