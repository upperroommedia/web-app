export function formatTime(sec: number): String {
  const hours: number = Math.floor(sec / 3600); // get hours
  const minutes: number = Math.floor((sec - hours * 3600) / 60); // get minutes
  const seconds: number = Math.floor(sec - hours * 3600 - minutes * 60); //  get seconds
  return (
    (hours > 0 ? hours + ':' : '') +
    String(minutes).padStart(2, '0') +
    ':' +
    String(seconds).padStart(2, '0')
  ); // Return is HH : MM : SS
}
