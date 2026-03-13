import { Sermon } from '../types/SermonTypes';

export function getSquareImageDownloadLink(sermon: Sermon) {
  return sermon.images
    .find((image) => image.type === 'square')
    ?.downloadLink;
}

export function debounce<T extends (...args: unknown[]) => unknown>(func: T, wait: number): T {
  let timeout: ReturnType<typeof setTimeout> | null;
  return ((...args: Parameters<T>): void => {
    const later = () => {
      timeout = null;
      func(...args);
    };
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  }) as T;
}
