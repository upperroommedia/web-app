import { fixedFormatToSeconds, secondsToFixedFormat } from '../components/trimmer/timeFormatting';

it.each([0, 0.1, 0.9, 10, 19.9, 59.9, 60, 3599.9, 3600])(
  'retains exact editing precision for %s seconds',
  (seconds) => {
    expect(fixedFormatToSeconds(secondsToFixedFormat(seconds))).toBe(seconds);
  }
);

it('formats a clamped end boundary without losing a tenth to floating point error', () => {
  expect(secondsToFixedFormat(20 - 0.1)).toBe('00:00:19.9');
  expect(secondsToFixedFormat(10.099)).toBe('00:00:10.0');
});

it.each([NaN, Infinity, -1])('keeps invalid duration %s out of editable text', (seconds) => {
  expect(secondsToFixedFormat(seconds)).toBe('00:00:00.0');
});
