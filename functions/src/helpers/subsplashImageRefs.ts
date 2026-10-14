import axios from '../providerSandbox/http';
import { AxiosRequestConfig } from 'axios';
import { executeProviderCreate } from '../temporal/publishing/providerReceipts';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
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
  app_key?: string;
  content_type?: string;
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
  bearerToken: string,
  operationKey?: string
): Promise<string> => {
  if (!image.downloadLink) {
    throw new Error(`Cannot repair Subsplash image "${image.name || image.type}" without a downloadLink.`);
  }

  logger.warn('repairing Subsplash image reference for type mismatch', {
    imageName: image.name,
    imageType: image.type,
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

  Object.assign(createConfig, { skipSubsplashEdgeRetry: true });
  const create = async (): Promise<SubsplashImageResponse> => {
    const result=(await axios(createConfig)).data as SubsplashImageResponse;
    if(!result.id) throw new Error('Subsplash returned no image ID.');
    return {id:result.id,...(result.type?{type:result.type}:{}),...(result.app_key?{app_key:result.app_key}:{}),...(result.content_type?{content_type:result.content_type}:{}),...(result._links?.presigned_upload_url?{_links:{presigned_upload_url:result._links.presigned_upload_url}}:{})};
  };
  const createdImage=operationKey
    ? await executeProviderCreate({operationKey,step:'image-create',payload:{image,contentType},execute:create})
    : await create();
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
  try {
    await axios(uploadConfig);
  } catch(error) {
    const status=axios.isAxiosError(error)?error.response?.status:undefined;
    if(!operationKey || ![401,403,410].includes(status ?? 0)) throw error;
    // A confirmed allocation is permanent; refresh only the upload capability on the same object.
    const current=await fetchRemoteImageRecord(remoteImageId,bearerToken);
    const freshUrl=current?._links?.presigned_upload_url?.href;
    if(!current || current.id!==remoteImageId || current.app_key!==APP_KEY || current.type!==image.type || current.content_type!==contentType || !freshUrl || freshUrl===uploadUrl) {
      throw new HttpsError('failed-precondition','The image upload capability expired. Restore the existing image before retrying.',{reason:'PROVIDER_UPLOAD_SLOT_UNAVAILABLE',provider:'subsplash',remoteId:remoteImageId});
    }
    try { await axios({...uploadConfig,url:freshUrl}); } catch {
      throw new HttpsError('failed-precondition','The existing image upload capability could not be restored.',{reason:'PROVIDER_UPLOAD_SLOT_UNAVAILABLE',provider:'subsplash',remoteId:remoteImageId});
    }
  }

  return remoteImageId;
};

export const repairMismatchedSubsplashImageRefs = async (
  images: Array<SubsplashPublishImageRef | undefined>,
  bearerToken: string,
  operationKey?: string
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

    const repairedSubsplashId = await uploadImageToSubsplash(image, bearerToken, operationKey ? `${operationKey}:image:${image.type}:${expectedRemoteId}` : undefined);
    resolvedImages.push({
      ...image,
      subsplashId: repairedSubsplashId,
    });
  }

  return resolvedImages;
};
