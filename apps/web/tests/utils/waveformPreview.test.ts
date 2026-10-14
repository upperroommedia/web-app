import { WaveformPreviewService, type PreviewWorker } from '../../components/trimmer/waveformPreview';
import { WAVEFORM_BUDGET } from '../../components/trimmer/waveformPcm';

function factory() {
  const workers: PreviewWorker[] = [];
  const create = jest.fn(() => {
    const worker: PreviewWorker = { onmessage: null, onerror: null, postMessage: jest.fn(), terminate: jest.fn() };
    workers.push(worker);
    return worker;
  });
  const finish = (index: number, peaks = new Float32Array(WAVEFORM_BUDGET.peaks)) => {
    const worker = workers[index];
    worker.onmessage?.call(worker as Worker, { data: { status: 'ready', peaks } } as MessageEvent);
  };
  return { workers, create, finish };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
it('coalesces source observers and reuses fixed cached peaks regardless of viewport redraws', () => {
  const service = new WaveformPreviewService(),
    source = new Blob(['wave']),
    { create, workers, finish } = factory();
  const a = jest.fn(),
    b = jest.fn();
  const stopA = service.observe(source, 1, create, a);
  service.observe(source, 1, create, b);
  stopA();
  finish(0);
  expect(a).not.toHaveBeenCalled();
  expect(b).toHaveBeenCalledTimes(1);
  for (let resize = 0; resize < 100; resize++) service.observe(source, 1, create, jest.fn());
  expect(create).toHaveBeenCalledTimes(1);
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
});
it('terminates superseded source work and ignores its late completion', () => {
  const service = new WaveformPreviewService(),
    { create, workers, finish } = factory();
  const old = jest.fn(),
    next = jest.fn();
  service.observe(new Blob(['old']), 1, create, old);
  const late = workers[0].onmessage;
  service.observe(new Blob(['next']), 1, create, next);
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  expect(old).toHaveBeenCalledWith({ status: 'unavailable', reason: 'cancelled' });
  late?.call(workers[0] as Worker, { data: { status: 'ready', peaks: new Float32Array(2048) } } as MessageEvent);
  expect(next).not.toHaveBeenCalled();
  finish(1);
  expect(next).toHaveBeenCalledTimes(1);
});
it('terminates the only active worker when the last consumer unmounts', () => {
  const service = new WaveformPreviewService(),
    { create, workers } = factory();
  const notify = jest.fn();
  const stop = service.observe(new Blob(['wave']), 1, create, notify);
  stop();
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  expect(notify).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
it('kills a stuck worker and rejects oversized or malformed peak messages', () => {
  const service = new WaveformPreviewService(),
    { create, workers, finish } = factory();
  const notify = jest.fn();
  service.observe(new Blob(['wave']), 1, create, notify);
  jest.advanceTimersByTime(WAVEFORM_BUDGET.elapsedMs + 1000);
  expect(workers[0].terminate).toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith({ status: 'unavailable', reason: 'budget' });
  service.observe(new Blob(['next']), 1, create, notify);
  finish(1, new Float32Array(9999));
  expect(notify).toHaveBeenLastCalledWith({ status: 'unavailable', reason: 'format' });
});
it('keeps at most eight source peak results and keys by actual blob identity', () => {
  const service = new WaveformPreviewService(),
    { create, finish } = factory();
  const sources = Array.from({ length: 9 }, () => new Blob(['same name and bytes']));
  sources.forEach((source, index) => {
    service.observe(source, 1, create, jest.fn());
    finish(index);
  });
  service.observe(sources[8], 1, create, jest.fn());
  expect(create).toHaveBeenCalledTimes(9);
  const stop = service.observe(sources[0], 1, create, jest.fn());
  expect(create).toHaveBeenCalledTimes(10);
  stop();
});
it('does not create a worker for unknown metadata or over-budget input', () => {
  const service = new WaveformPreviewService(),
    { create } = factory();
  service.observe(new Blob(['small']), NaN, create, jest.fn());
  service.observe(new Blob(['small']), 601, create, jest.fn());
  expect(create).not.toHaveBeenCalled();
});
