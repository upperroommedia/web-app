import { Sermon } from '../types/SermonTypes';

export function getSquareImageStoragePath(sermon: Sermon) {
  const encodedPath = sermon.images
    .find((image) => image.type === 'square')
    ?.downloadLink.split('/')
    .pop();
  const imageStoragePath = encodedPath ? decodeURIComponent(encodedPath) : undefined;
  return imageStoragePath;
}

export function debounce<T extends (...args: any[]) => any>(func: T, wait: number): T {
  let timeout: ReturnType<typeof setTimeout> | null;
  return ((...args: Parameters<T>): void => {
    const later = () => {
      timeout = null;
      func(...args);
    };
    if (timeout) {
      console.log('Debounced');
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  }) as T;
}
