/** Optional preview budgets; these never restrict playable or uploadable audio. */
export const WAVEFORM_BUDGET = Object.freeze({
  inputBytes: 32 * 1024 * 1024,
  decodedBytes: 64 * 1024 * 1024,
  chunkBytes: 256 * 1024,
  peaks: 2048,
  chunks: 64,
  durationSeconds: 600,
  elapsedMs: 5000,
});
export type WaveformPreview =
  | { status: 'ready'; peaks: Float32Array }
  | { status: 'unavailable'; reason: 'format' | 'budget' | 'metadata' | 'cancelled' };

const unavailable = (reason: Extract<WaveformPreview, { status: 'unavailable' }>['reason']): WaveformPreview => ({
  status: 'unavailable',
  reason,
});
const tag = (view: DataView, offset: number) =>
  String.fromCharCode(...Array.from({ length: 4 }, (_, i) => view.getUint8(offset + i)));

/**
 * Read known PCM directly in bounded slices. Never invoke a browser decoder:
 * compressed headers/duration cannot bound the decoder's internal PCM allocation.
 */
export async function buildPcmWaveform(
  blob: Blob,
  duration: number,
  options: { cancelled?: () => boolean; now?: () => number } = {}
): Promise<WaveformPreview> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const check = () => {
    if (options.cancelled?.()) return 'cancelled' as const;
    if (now() - started > WAVEFORM_BUDGET.elapsedMs) return 'budget' as const;
    return undefined;
  };
  if (!Number.isFinite(duration) || duration <= 0) return unavailable('metadata');
  if (
    !Number.isSafeInteger(blob.size) ||
    blob.size > WAVEFORM_BUDGET.inputBytes ||
    duration > WAVEFORM_BUDGET.durationSeconds
  )
    return unavailable('budget');
  if (blob.size < 44) return unavailable('format');
  const read = async (offset: number, bytes: number) => {
    const buffer = await blob.slice(offset, offset + bytes).arrayBuffer();
    if (buffer.byteLength !== bytes) throw new Error('TRUNCATED_WAVEFORM_INPUT');
    return new DataView(buffer);
  };
  try {
    const initiallyStopped = check();
    if (initiallyStopped) return unavailable(initiallyStopped);
    const header = await read(0, 12);
    if (tag(header, 0) !== 'RIFF' || tag(header, 8) !== 'WAVE' || header.getUint32(4, true) + 8 !== blob.size)
      return unavailable('format');
    let format: { code: number; channels: number; rate: number; align: number; bits: number } | undefined;
    let data: { offset: number; bytes: number } | undefined;
    let offset = 12;
    let chunks = 0;
    while (offset < blob.size) {
      const stopped = check();
      if (stopped) return unavailable(stopped);
      if (++chunks > WAVEFORM_BUDGET.chunks) return unavailable('budget');
      if (offset + 8 > blob.size) return unavailable('format');
      const chunk = await read(offset, 8);
      const bytes = chunk.getUint32(4, true);
      const start = offset + 8;
      const next = start + bytes + (bytes % 2);
      if (next > blob.size) return unavailable('format');
      if (tag(chunk, 0) === 'fmt ') {
        if (format || ![16, 18].includes(bytes)) return unavailable('format');
        const fmt = await read(start, bytes);
        const code = fmt.getUint16(0, true),
          channels = fmt.getUint16(2, true),
          rate = fmt.getUint32(4, true);
        const align = fmt.getUint16(12, true),
          bits = fmt.getUint16(14, true);
        if (
          ![1, 2].includes(channels) ||
          rate < 8000 ||
          rate > 192000 ||
          !((code === 1 && [8, 16, 24, 32].includes(bits)) || (code === 3 && bits === 32)) ||
          align !== channels * (bits / 8) ||
          fmt.getUint32(8, true) !== rate * align ||
          (bytes === 18 && fmt.getUint16(16, true) !== 0)
        )
          return unavailable('format');
        format = { code, channels, rate, align, bits };
      } else if (tag(chunk, 0) === 'data') {
        if (data) return unavailable('format');
        data = { offset: start, bytes };
      }
      offset = next;
    }
    if (!format || !data || !data.bytes || data.bytes % format.align !== 0) return unavailable('format');
    const frames = data.bytes / format.align;
    const actualDuration = frames / format.rate;
    if (
      !Number.isSafeInteger(frames * format.channels * 4) ||
      frames * format.channels * 4 > WAVEFORM_BUDGET.decodedBytes
    )
      return unavailable('budget');
    if (Math.abs(actualDuration - duration) > Math.max(0.05, actualDuration * 0.01)) return unavailable('metadata');
    const peaks = new Float32Array(WAVEFORM_BUDGET.peaks);
    const frameBytes = Math.floor(WAVEFORM_BUDGET.chunkBytes / format.align) * format.align;
    let maximum = 0;
    for (let consumed = 0; consumed < data.bytes; consumed += frameBytes) {
      const stopped = check();
      if (stopped) return unavailable(stopped);
      const view = await read(data.offset + consumed, Math.min(frameBytes, data.bytes - consumed));
      for (let byte = 0; byte < view.byteLength; byte += format.align) {
        const frame = (consumed + byte) / format.align;
        let peak = 0;
        for (let channel = 0; channel < format.channels; channel++) {
          const sample = byte + channel * (format.bits / 8);
          let value: number;
          if (format.code === 3) value = view.getFloat32(sample, true);
          else if (format.bits === 8) value = (view.getUint8(sample) - 128) / 128;
          else if (format.bits === 16) value = view.getInt16(sample, true) / 32768;
          else if (format.bits === 24) {
            const raw = view.getUint8(sample) | (view.getUint8(sample + 1) << 8) | (view.getInt8(sample + 2) << 16);
            value = raw / 8388608;
          } else value = view.getInt32(sample, true) / 2147483648;
          if (!Number.isFinite(value)) return unavailable('format');
          peak = Math.max(peak, Math.min(1, Math.abs(value)));
        }
        const bin = Math.min(peaks.length - 1, Math.floor((frame * peaks.length) / frames));
        peaks[bin] = Math.max(peaks[bin], peak);
        maximum = Math.max(maximum, peak);
      }
    }
    const stopped = check();
    if (stopped) return unavailable(stopped);
    if (maximum > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= maximum;
    return { status: 'ready', peaks };
  } catch {
    return unavailable(check() ?? 'format');
  }
}
