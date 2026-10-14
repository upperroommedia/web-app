import type {
  CreateSpeakerCallableInputType,
  CreateSpeakerCallableOutputType,
} from '@upperroom/contracts/speakers/createSpeakerTypes';
import type { ImageType } from '../../types/Image';

export interface BuildCreateSpeakerPayloadInput {
  name: string;
  images: ImageType[];
  shortDescription?: string;
  description?: string;
  createSpeakerList?: boolean;
}

export const buildCreateSpeakerPayload = ({
  name,
  images,
  shortDescription,
  description,
  createSpeakerList,
}: BuildCreateSpeakerPayloadInput): CreateSpeakerCallableInputType => {
  const normalizedShortDescription = shortDescription?.trim();
  const normalizedDescription = description?.trim();
  const payload: CreateSpeakerCallableInputType = {
    speaker: {
      name: name.trim(),
      images,
      ...(normalizedShortDescription ? { shortDescription: normalizedShortDescription } : {}),
      ...(normalizedDescription ? { description: normalizedDescription } : {}),
    },
  };

  if (typeof createSpeakerList === 'boolean') {
    payload.createSpeakerList = createSpeakerList;
  }

  return payload;
};

export const shouldShowSpeakerListSuccess = (
  response: Pick<CreateSpeakerCallableOutputType, 'speakerListCreated'>
): boolean => response.speakerListCreated === true;
