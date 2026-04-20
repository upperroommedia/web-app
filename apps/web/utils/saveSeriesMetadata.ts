import { serverTimestamp } from 'firebase/firestore';
import firestore, { doc, updateDoc } from '../firebase/firestore';
import { createFunctionV2 } from './createFunction';
import { Series } from '../types/Series';
import type {
  UpdateSeriesMetadataImageInput,
  UpdateSeriesMetadataInputType,
  UpdateSeriesMetadataOutputType,
} from '@upperroom/contracts/updateSeriesMetadata';

export const getDerivedSeriesSubtitle = (publishedItemCount: number): string => `${publishedItemCount} part series`;

type SaveSeriesMetadataInput = {
  series: Series;
  name: string;
  summary: string;
  images: Series['images'];
};

const mergeSeriesImages = (
  localImages: Series['images'],
  remoteImages: UpdateSeriesMetadataImageInput[]
): Series['images'] => {
  if (remoteImages.length === 0) {
    return localImages;
  }

  const remoteImagesById = new Map(remoteImages.map((image) => [image.id, image]));
  const remoteImagesByType = new Map(remoteImages.map((image) => [image.type, image]));

  return localImages.map((image) => {
    const remoteImage = remoteImagesById.get(image.id) || remoteImagesByType.get(image.type);

    return remoteImage
      ? {
          ...image,
          id: remoteImage.id || image.id,
          downloadLink: remoteImage.downloadLink || image.downloadLink,
          name: remoteImage.name || image.name,
          subsplashId: remoteImage.subsplashId || image.subsplashId,
        }
      : image;
  });
};

export const saveSeriesMetadata = async ({
  series,
  name,
  summary,
  images,
}: SaveSeriesMetadataInput): Promise<Series> => {
  const trimmedName = name.trim();
  const trimmedSummary = summary.trim();
  const derivedSubtitle = getDerivedSeriesSubtitle(series.publishedItemCount || 0);

  if (!series.subsplashId) {
    await updateDoc(doc(firestore, 'series', series.id), {
      name: trimmedName,
      subtitle: derivedSubtitle,
      summary: trimmedSummary || null,
      images,
      updatedAt: serverTimestamp(),
    });

    return {
      ...series,
      name: trimmedName,
      subtitle: derivedSubtitle,
      summary: trimmedSummary || undefined,
      images,
    };
  }

  const updateSeriesMetadataFunction = createFunctionV2<
    UpdateSeriesMetadataInputType,
    UpdateSeriesMetadataOutputType
  >('updateseriesmetadata');

  const result = await updateSeriesMetadataFunction({
    firestoreId: series.id,
    title: trimmedName,
    summary: trimmedSummary || null,
    images,
  });

  if (result.status !== 'success') {
    throw new Error(result.error || 'Failed to update series metadata');
  }

  const mergedImages = mergeSeriesImages(images, result.images);

  return {
    ...series,
    name: result.title,
    subtitle: result.subtitle,
    summary: result.summary,
    images: mergedImages,
    status: result.remoteStatus,
    slug: result.slug ?? series.slug,
    shortCode: result.shortCode ?? series.shortCode,
    position: result.position ?? series.position,
  };
};
