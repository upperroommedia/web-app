import axios, { AxiosRequestConfig } from 'axios';
import { logger } from 'firebase-functions/v2';
import { createAxiosConfig } from '../subsplashUtils';

const APP_KEY = '9XTSHD';

export type SubsplashPublishImageRef = {
  id: string;
  type: string;
  downloadLink?: string;
  name?: string;
  subsplashId?: string;
};

type SubsplashImageResponse = {
  id: string;
  type?: string;
  _links?: {
    presigned_upload_url?: { href?: string };
  };
};

const getContentTypeFromHeaders = (headers: unknown): string | undefined => {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }

  const values = headers as Record<string, unknown>;
  const contentType = values['content-type'] ?? values['Content-Type'];
  return typeof contentType === 'string' && contentType.trim() ? contentType : undefined;
};

const fetchRemoteImageRecord = async (
  remoteImageId: string,
  bearerToken: string
): Promise<SubsplashImageResponse | null> => {
  const config = createAxiosConfig(
    `https://core.subsplash.com/files/v1/images/${remoteImageId}`,
    bearerToken,
    'GET'
  );

  try {
    const response = await axios(config);
    return response.data as SubsplashImageResponse;
  } catch (error) {
    const status =
      axios.isAxiosError(error)
        ? error.response?.status
        : error && typeof error === 'object' && 'response' in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
    if (status === 404) {
      return null;
    }
    throw error;
  }
};

const uploadImageToSubsplash = async (
  image: Pick<SubsplashPublishImageRef, 'downloadLink' | 'name' | 'type'>,
  bearerToken: string
): Promise<string> => {
  if (!image.downloadLink) {
    throw new Error(`Cannot repair Subsplash image "${image.name || image.type}" without a downloadLink.`);
  }

  logger.warn('repairing Subsplash image reference for type mismatch', {
    imageName: image.name,
    imageType: image.type,
    downloadLink: image.downloadLink,
  });

  const sourceResponse = await axios<ArrayBuffer>({
    method: 'GET',
    url: image.downloadLink,
    responseType: 'arraybuffer',
  });
  const contentType = getContentTypeFromHeaders(sourceResponse.headers) || 'image/jpeg';

  const createConfig = createAxiosConfig(
    'https://core.subsplash.com/files/v1/images',
    bearerToken,
    'POST',
    {
      app_key: APP_KEY,
      content_type: contentType,
      title: image.name || image.downloadLink.split('/').pop() || 'Repaired image',
      type: image.type,
    }
  );

  const createResponse = await axios(createConfig);
  const createdImage = createResponse.data as SubsplashImageResponse;
  const remoteImageId = createdImage.id;
  const uploadUrl = createdImage._links?.presigned_upload_url?.href;

  if (!remoteImageId) {
    throw new Error(`Subsplash did not return an image id while repairing "${image.name}".`);
  }
  if (!uploadUrl) {
    throw new Error(`Subsplash did not return an upload URL while repairing "${image.name}".`);
  }

  const uploadConfig: AxiosRequestConfig = {
    url: uploadUrl,
    method: 'PUT',
    data: sourceResponse.data,
    headers: {
      'Content-Type': contentType,
      Origin: 'https://dashboard.subsplash.com',
      'x-amz-acl': 'public-read',
    },
  };
  await axios(uploadConfig);

  return remoteImageId;
};

export const repairMismatchedSubsplashImageRefs = async (
  images: Array<SubsplashPublishImageRef | undefined>,
  bearerToken: string
): Promise<SubsplashPublishImageRef[]> => {
  const resolvedImages: SubsplashPublishImageRef[] = [];

  for (const image of images) {
    if (!image) {
      continue;
    }

    const expectedRemoteId = image.subsplashId || image.id;
    if (!expectedRemoteId) {
      resolvedImages.push(image);
      continue;
    }

    const remoteImage = await fetchRemoteImageRecord(expectedRemoteId, bearerToken);
    if (remoteImage?.type === image.type) {
      resolvedImages.push({
        ...image,
        subsplashId: expectedRemoteId,
      });
      continue;
    }

    if (!image.downloadLink) {
      logger.warn('keeping existing Subsplash image reference because no downloadLink is available for repair', {
        imageId: image.id,
        subsplashId: image.subsplashId,
        imageType: image.type,
        remoteType: remoteImage?.type ?? null,
      });
      resolvedImages.push({
        ...image,
        subsplashId: expectedRemoteId,
      });
      continue;
    }

    const repairedSubsplashId = await uploadImageToSubsplash(image, bearerToken);
    resolvedImages.push({
      ...image,
      subsplashId: repairedSubsplashId,
    });
  }

  return resolvedImages;
};
