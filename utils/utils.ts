import { Sermon } from '../types/SermonTypes';

export function getSquareImageStoragePath(sermon: Sermon) {
  const imageId = sermon.images.find((image) => image.type === 'square')?.id;
  const imageStoragePath = imageId ? `speaker-images/${imageId}-square.jpeg` : undefined;
  return imageStoragePath;
}
