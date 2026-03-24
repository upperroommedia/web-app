import { Area } from 'react-easy-crop/types';
import { ImageSizeType } from '../types/Image';

const createImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', (error) => reject(error));
    image.crossOrigin = 'anonymous'; // needed to avoid cross-origin issues
    image.src = url;
  });

function getRadianAngle(degreeValue: number) {
  return (degreeValue * Math.PI) / 180;
}

const clampColorChannel = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

const toHexColor = (red: number, green: number, blue: number): string =>
  `#${[red, green, blue]
    .map((channel) => clampColorChannel(channel).toString(16).padStart(2, '0'))
    .join('')}`;

export const computeAverageColorHexForImage = (image: HTMLImageElement): string => {
  const sampleCanvas = document.createElement('canvas');
  const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });

  if (!sampleContext) {
    return '#9fccb9';
  }

  const sampleWidth = 32;
  const sampleHeight = Math.max(1, Math.round((image.naturalHeight / Math.max(image.naturalWidth, 1)) * sampleWidth));
  sampleCanvas.width = sampleWidth;
  sampleCanvas.height = sampleHeight;
  sampleContext.drawImage(image, 0, 0, sampleWidth, sampleHeight);

  const { data } = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight);
  let red = 0;
  let green = 0;
  let blue = 0;
  let pixelCount = 0;

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha === 0) {
      continue;
    }

    red += data[index];
    green += data[index + 1];
    blue += data[index + 2];
    pixelCount += 1;
  }

  if (pixelCount === 0) {
    return '#9fccb9';
  }

  return toHexColor(red / pixelCount, green / pixelCount, blue / pixelCount);
};

export const resolveImageBackgroundColorHex = async (imageSrc: string): Promise<string> => {
  const image = await createImage(imageSrc);
  return computeAverageColorHexForImage(image);
};

/**
 * Returns the new bounding area of a rotated rectangle.
 */
function rotateSize(width: number, height: number, rotation: number) {
  const rotRad = getRadianAngle(rotation);

  return {
    width: Math.abs(Math.cos(rotRad) * width) + Math.abs(Math.sin(rotRad) * height),
    height: Math.abs(Math.sin(rotRad) * width) + Math.abs(Math.cos(rotRad) * height),
  };
}

export interface CroppedImageData {
  url: string;
  blob: Blob;
  contentType: string;
  type: ImageSizeType;
}

/**
 * This function was adapted from the one in the ReadMe of https://github.com/DominicTobias/react-image-crop
 */
export default async function getCroppedImg(
  imageSrc: string,
  pixelCrop: Area,
  rotation = 0,
  type: ImageSizeType,
  backgroundColorHex?: string,
  flip = { horizontal: false, vertical: false }
): Promise<CroppedImageData | undefined> {
  const image = await createImage(imageSrc);
  const sourceCanvas = document.createElement('canvas');
  const sourceContext = sourceCanvas.getContext('2d');
  const outputCanvas = document.createElement('canvas');
  const outputContext = outputCanvas.getContext('2d');

  if (!sourceContext || !outputContext) {
    return;
  }

  const rotRad = getRadianAngle(rotation);

  // calculate bounding box of the rotated image
  const { width: bBoxWidth, height: bBoxHeight } = rotateSize(image.width, image.height, rotation);

  // set canvas size to match the bounding box
  sourceCanvas.width = bBoxWidth;
  sourceCanvas.height = bBoxHeight;
  const resolvedBackgroundColorHex = backgroundColorHex ?? computeAverageColorHexForImage(image);
  sourceContext.fillStyle = resolvedBackgroundColorHex;
  sourceContext.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);

  // translate canvas context to a central location to allow rotating and flipping around the center
  sourceContext.translate(bBoxWidth / 2, bBoxHeight / 2);
  sourceContext.rotate(rotRad);
  sourceContext.scale(flip.horizontal ? -1 : 1, flip.vertical ? -1 : 1);
  sourceContext.translate(-image.width / 2, -image.height / 2);

  // draw rotated image
  sourceContext.drawImage(image, 0, 0);

  // Render the requested crop area onto a fresh canvas so any regions outside the
  // rotated image bounds keep the selected background color instead of turning transparent.
  outputCanvas.width = pixelCrop.width;
  outputCanvas.height = pixelCrop.height;
  outputContext.fillStyle = resolvedBackgroundColorHex;
  outputContext.fillRect(0, 0, outputCanvas.width, outputCanvas.height);
  outputContext.drawImage(
    sourceCanvas,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    pixelCrop.width,
    pixelCrop.height
  );

  // As Base64 string
  // return canvas.toDataURL('image/jpeg');

  // As a blob
  const contentType = 'image/jpeg';
  return new Promise((resolve, reject) => {
    outputCanvas.toBlob((file) => {
      if (!file) {
        reject(new Error('Canvas is empty'));
        return;
      }
      resolve({ blob: file, url: URL.createObjectURL(file), contentType, type });
    }, contentType);
  });
}
