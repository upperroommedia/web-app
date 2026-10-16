import { buildPcmWaveform, WAVEFORM_BUDGET } from '../../components/trimmer/waveformPcm';

function wav({ bits = 16, channels = 1, rate = 8000, frames = 800, code = 1 } = {}) {
  const bytes = bits / 8;
  const buffer = new ArrayBuffer(44 + frames * channels * bytes);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, code, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * bytes, true);
  view.setUint16(32, channels * bytes, true);
  view.setUint16(34, bits, true);
  text(36, 'data');
  view.setUint32(40, frames * channels * bytes, true);
  return { buffer, view, duration: frames / rate };
}
const blob = (buffer: ArrayBuffer) => new Blob([buffer], { type: 'audio/wav' });

it.each([8, 16, 24, 32])(
  'aggregates PCM%s into fixed finite normalized peaks without browser decoding',
  async (bits) => {
    const input = wav({ bits, channels: 2 });
    input.view.setUint8(44, 64);
    const result = await buildPcmWaveform(blob(input.buffer), input.duration);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected peaks');
    expect(result.peaks.length).toBe(WAVEFORM_BUDGET.peaks);
    expect([...result.peaks].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
  }
);
it('uses right-channel peaks too', async () => {
  const input = wav({ channels: 2 });
  input.view.setInt16(46, 30000, true);
  const result = await buildPcmWaveform(blob(input.buffer), input.duration);
  expect(result.status === 'ready' && result.peaks[0]).toBe(1);
});
it('normalizes finite float32 PCM and rejects NaN samples', async () => {
  const input = wav({ bits: 32, code: 3 });
  input.view.setFloat32(44, 0.5, true);
  expect((await buildPcmWaveform(blob(input.buffer), input.duration)).status).toBe('ready');
  input.view.setFloat32(44, NaN, true);
  expect(await buildPcmWaveform(blob(input.buffer), input.duration)).toMatchObject({
    status: 'unavailable',
    reason: 'format',
  });
});
it.each([
  (v: DataView) => v.setUint32(4, 999999, true),
  (v: DataView) => v.setUint16(20, 65534, true),
  (v: DataView) => v.setUint16(22, 100, true),
  (v: DataView) => v.setUint32(28, 42, true),
  (v: DataView) => v.setUint16(32, 1, true),
  (v: DataView) => v.setUint32(40, 0xffffffff, true),
  (v: DataView) => v.setUint32(16, 0xffffffff, true),
])('rejects structurally inconsistent WAV before allocating PCM', async (mutate) => {
  const input = wav();
  mutate(input.view);
  expect((await buildPcmWaveform(blob(input.buffer), input.duration)).status).toBe('unavailable');
});
it('rejects compressed input without reading the full file', async () => {
  const input = new Blob([new Uint8Array(1_000_000)]);
  const slice = jest.spyOn(input, 'slice');
  expect((await buildPcmWaveform(input, 1)).status).toBe('unavailable');
  expect(slice).toHaveBeenCalledTimes(1);
  expect(slice).toHaveBeenCalledWith(0, 12);
});
it('rejects excessive compressed bytes or unknown/long duration before any read', async () => {
  const input = new Blob([new Uint8Array(WAVEFORM_BUDGET.inputBytes + 1)]);
  const slice = jest.spyOn(input, 'slice');
  expect((await buildPcmWaveform(input, 1)).status).toBe('unavailable');
  expect((await buildPcmWaveform(blob(wav().buffer), Infinity)).status).toBe('unavailable');
  expect((await buildPcmWaveform(blob(wav().buffer), 601)).status).toBe('unavailable');
  expect(slice).not.toHaveBeenCalled();
});
it('rejects understated decoded size and duration mismatches using actual header metadata', async () => {
  const input = wav({ bits: 8, channels: 2, frames: 9_000_000, rate: 192000 });
  expect(await buildPcmWaveform(blob(input.buffer), input.duration)).toMatchObject({ reason: 'budget' });
  const short = wav();
  expect(await buildPcmWaveform(blob(short.buffer), 10)).toMatchObject({ reason: 'metadata' });
});
it('reads data only through bounded slices', async () => {
  const input = wav({ frames: 300_000 });
  const source = blob(input.buffer),
    slice = jest.spyOn(source, 'slice');
  expect((await buildPcmWaveform(source, input.duration, { now: () => 0 })).status).toBe('ready');
  const dataSlices = slice.mock.calls.filter(([start = 0]) => start >= 44);
  expect(dataSlices.length).toBeGreaterThan(1);
  expect(dataSlices[0]).toEqual([44, 44 + WAVEFORM_BUDGET.chunkBytes]);
  expect(dataSlices.at(-1)?.[1]).toBe(source.size);
  expect(slice.mock.calls.every(([start = 0, end = source.size]) => end - start <= WAVEFORM_BUDGET.chunkBytes)).toBe(
    true
  );
});
it('stops on cancellation and elapsed CPU budget, including after an asynchronous read', async () => {
  const input = wav();
  let cancelled = false;
  const source = blob(input.buffer),
    originalSlice = source.slice.bind(source);
  jest.spyOn(source, 'slice').mockImplementation((start, end) => {
    cancelled = true;
    return originalSlice(start, end);
  });
  expect(await buildPcmWaveform(source, input.duration, { cancelled: () => cancelled })).toMatchObject({
    reason: 'cancelled',
  });
  let time = 0;
  const timedSource = blob(input.buffer),
    originalTimedSlice = timedSource.slice.bind(timedSource);
  const timedSlice = jest.spyOn(timedSource, 'slice').mockImplementation((start, end) => {
    const part = originalTimedSlice(start, end);
    const originalArrayBuffer = part.arrayBuffer.bind(part);
    jest.spyOn(part, 'arrayBuffer').mockImplementation(async () => {
      const buffer = await originalArrayBuffer();
      time = 5001; // Advance only after the genuine asynchronous read completes.
      return buffer;
    });
    return part;
  });
  expect(await buildPcmWaveform(timedSource, input.duration, { now: () => time })).toEqual({
    status: 'unavailable',
    reason: 'budget',
  });
  expect(timedSlice).toHaveBeenCalledTimes(1);
  expect(timedSlice).toHaveBeenCalledWith(0, 12);
});
it('rejects duplicate data chunks and caps header traversal', async () => {
  const input = wav();
  const original = new Uint8Array(input.buffer);
  const duplicate = new Uint8Array(original.length + 8);
  duplicate.set(original);
  duplicate.set(new TextEncoder().encode('data'), original.length);
  new DataView(duplicate.buffer).setUint32(4, duplicate.length - 8, true);
  expect((await buildPcmWaveform(new Blob([duplicate]), input.duration)).status).toBe('unavailable');
  const many = new Uint8Array(original.length + 65 * 8);
  many.set(original.slice(0, 12));
  for (let i = 0; i < 65; i++) many.set(new TextEncoder().encode('JUNK'), 12 + i * 8);
  many.set(original.slice(12), 12 + 65 * 8);
  new DataView(many.buffer).setUint32(4, many.length - 8, true);
  expect(await buildPcmWaveform(new Blob([many]), input.duration)).toMatchObject({ reason: 'budget' });
});
it('accepts a valid odd data chunk only with its required RIFF padding', async () => {
  const input = wav({ bits: 8, frames: 801 });
  expect((await buildPcmWaveform(blob(input.buffer), input.duration)).status).toBe('unavailable');
  const padded = new Uint8Array(input.buffer.byteLength + 1);
  padded.set(new Uint8Array(input.buffer));
  new DataView(padded.buffer).setUint32(4, padded.length - 8, true);
  expect((await buildPcmWaveform(new Blob([padded]), input.duration)).status).toBe('ready');
});
