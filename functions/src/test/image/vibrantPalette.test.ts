import sharp from 'sharp';
import computeMetadataForImage, { vibrantHexFromRgba } from '../../computeMetadataForImage';

jest.mock('firebase-functions', () => ({ logger: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } }));

const rgba = async (
  background: string | { r: number; g: number; b: number; alpha: number },
  width = 80,
  height = 40
) => {
  const { data, info } = await sharp({ create: { width, height, channels: 4, background } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, ...info };
};

// Recorded from real node-vibrant/node 4.0.4 on these same small PNGs before
// replacing its Jimp adapter. Quantizer and generator remain upstream 4.0.4.
test.each([
  ['#123456', '#317fcd'],
  ['#dd2222', '#dc2424'],
  ['#228844', '#248c44'],
  ['#000000', '#7f7f7f'],
  ['#888888', undefined],
  ['#ffffff', undefined],
])('preserves the original monochrome palette for %s', async (background, expected) => {
  expect(await vibrantHexFromRgba(await rgba(background))).toBe(expected);
});

test.each([0, 0.25, 124 / 255])('excludes alpha below the original 125 threshold (%s)', async (alpha) => {
  expect(await vibrantHexFromRgba(await rgba({ r: 221, g: 34, b: 34, alpha }))).toBeUndefined();
});

test('retains partially transparent eligible colors and excludes only near-white RGB', async () => {
  expect(await vibrantHexFromRgba(await rgba({ r: 221, g: 34, b: 34, alpha: 125 / 255 }))).toBe('#dc2424');
  expect(await vibrantHexFromRgba(await rgba('#fbfbfb'))).toBeUndefined();
  expect(await vibrantHexFromRgba(await rgba('#fafafa'))).toBe('#7f7f7f'); // Original generator synthesizes this swatch from near-white.
});

test('does not mutate caller-owned pixels or blend transparent RGB into an invented background', async () => {
  const input = await rgba({ r: 0, g: 255, b: 0, alpha: 0 });
  const before = Buffer.from(input.data);
  expect(await vibrantHexFromRgba(input)).toBeUndefined();
  expect(input.data).toEqual(before);
});

test.each([
  [1, 1],
  [1, 128],
  [128, 1],
  [128, 128],
])('handles quality rounding at %sx%s', async (width, height) => {
  expect(await vibrantHexFromRgba(await rgba('#dd2222', width, height))).toBe('#dc2424');
});

test.each([
  { width: 129, height: 1, channels: 4, data: new Uint8Array(516) },
  { width: 1, height: 129, channels: 4, data: new Uint8Array(516) },
  { width: 0, height: 1, channels: 4, data: new Uint8Array(0) },
  { width: 1.5, height: 1, channels: 4, data: new Uint8Array(6) },
  { width: 1, height: 1, channels: 3, data: new Uint8Array(3) },
  { width: 1, height: 1, channels: 4, data: new Uint8Array(3) },
  { width: 1, height: 1, channels: 4, data: new Uint8Array(5) },
])('rejects malformed or oversized RGBA before quantization %#', async (input) => {
  await expect(vibrantHexFromRgba(input)).rejects.toThrow('bounded RGBA');
});

test('real end-to-end extraction preserves average color and vibrant color', async () => {
  const input = await sharp({ create: { width: 512, height: 256, channels: 3, background: '#dd2222' } })
    .png()
    .toBuffer();
  expect(await computeMetadataForImage(input)).toEqual({
    width: 512,
    height: 256,
    averageColorHex: '#dd2222',
    vibrantColorHex: '#dc2424',
  });
});

test.each(['#ffffff', { r: 255, g: 0, b: 0, alpha: 0 }])(
  'retains the stable fallback when a valid image has no vibrant pixels (%s)',
  async (background) => {
    const input = await sharp({ create: { width: 8, height: 4, channels: 4, background } })
      .png()
      .toBuffer();
    expect(await computeMetadataForImage(input)).toMatchObject({ width: 8, height: 4, vibrantColorHex: '#2b7256' });
  }
);

test('keeps the original dominant color for a real two-color image', async () => {
  const width = 100;
  const height = 50;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(x < 50 ? [221, 34, 34, 255] : [34, 136, 68, 255], (y * width + x) * 4);
  }
  // Original real node-vibrant output for this exact two-block fixture.
  expect(await vibrantHexFromRgba({ data, width, height, channels: 4 })).toBe('#dc2424');
});

test('matches the original palette for a two-dimensional gradient', async () => {
  const width = 100;
  const height = 50;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(
        [Math.round((x * 255) / (width - 1)), Math.round((y * 255) / (height - 1)), 80, 255],
        (y * width + x) * 4
      );
    }
  }
  // Original real node-vibrant output, including its quality=5 reduction.
  expect(await vibrantHexFromRgba({ data, width, height, channels: 4 })).toBe('#18e854');
});
