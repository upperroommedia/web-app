import { Sermon } from '../types/SermonTypes';

export function getSquareImageStoragePath(sermon: Sermon) {
  const encodedPath = sermon.images
    .find((image) => image.type === 'square')
    ?.downloadLink.split('/')
    .pop();
  const imageStoragePath = encodedPath ? decodeURIComponent(encodedPath) : undefined;
  return imageStoragePath;
}
