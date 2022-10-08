function convertToHMS(sec: number): {
  hours: number;
  minutes: number;
  seconds: number;
} {
  const hours: number = Math.floor(sec / 3600); // get hours
  const minutes: number = Math.floor((sec - hours * 3600) / 60); // get minutes
  const seconds: number = Math.floor(sec - hours * 3600 - minutes * 60); //  get seconds
  return { hours, minutes, seconds };
}

export function formatTime(sec: number): String {
  const { hours, minutes, seconds } = convertToHMS(sec);
  return (hours > 0 ? hours + ':' : '') + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0'); // Return is HH : MM : SS
}

export function formatRemainingTime(sec: number): String {
  const { hours, minutes, seconds } = convertToHMS(sec);
  const hr = hours > 0 ? `${hours} hr ` : '';
  const min = minutes > 0 ? `${minutes} min ` : '';
  const s = hours < 1 && minutes < 1 ? `${seconds} sec` : '';
  return (hr + min + s).trim();
}
