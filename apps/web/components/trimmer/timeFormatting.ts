/** Fixed editing precision: HH:MM:SS.m. Work in integer tenths to avoid 19.9 displaying as 19.8. */
export function secondsToFixedFormat(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00.0';
  const totalTenths = Math.floor((seconds + Number.EPSILON * Math.max(1, seconds)) * 10);
  const hours = Math.min(99, Math.floor(totalTenths / 36000));
  const minutes = Math.floor(totalTenths / 600) % 60;
  const secs = Math.floor(totalTenths / 10) % 60;
  const tenths = totalTenths % 10;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(
    2,
    '0'
  )}.${tenths}`;
}

export function fixedFormatToSeconds(value: string): number {
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length < 7) return 0;
  const hours = parseInt(digits.slice(0, 2), 10) || 0;
  const minutes = parseInt(digits.slice(2, 4), 10) || 0;
  const seconds = parseInt(digits.slice(4, 6), 10) || 0;
  const tenths = parseInt(digits.slice(6, 7), 10) || 0;
  return hours * 3600 + minutes * 60 + seconds + tenths / 10;
}
