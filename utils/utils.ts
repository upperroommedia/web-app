import { Sermon } from '../types/SermonTypes';

export function getSquareImageStoragePath(sermon: Sermon) {
  const defaultImagePath = 'app-images/upper_room_media_logo.png';
  const imageId = sermon.images.find((image) => image.type === 'square')?.id;
  const imageStoragePath = imageId ? `speaker-images/${imageId}` : defaultImagePath;
  return imageStoragePath;
}
