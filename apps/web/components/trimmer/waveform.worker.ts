import { buildPcmWaveform } from './waveformPcm';

// One source per short-lived worker. Termination cancels reads and computation.
self.onmessage = async (event: MessageEvent<{ blob: Blob; duration: number }>) => {
  const result = await buildPcmWaveform(event.data.blob, event.data.duration);
  if (result.status === 'ready') self.postMessage(result, { transfer: [result.peaks.buffer] });
  else self.postMessage(result);
};
