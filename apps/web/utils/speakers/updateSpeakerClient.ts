import type {
  UpdateSpeakerCallableInputType,
  UpdateSpeakerPatchType,
} from '@upperroom/contracts/speakers/createSpeakerTypes';
import type { ImageType } from '../../types/Image';

export interface BuildUpdateSpeakerPayloadInput {
  speakerId: string;
  name: string;
  images: ImageType[];
  shortDescription?: string;
  description?: string;
  createSpeakerList?: boolean;
  deleteAssociatedList?: boolean;
}

const normalizeOptionalPatchString = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export const buildUpdateSpeakerPayload = ({
  speakerId,
  name,
  images,
  shortDescription,
  description,
  createSpeakerList,
  deleteAssociatedList,
}: BuildUpdateSpeakerPayloadInput): UpdateSpeakerCallableInputType => {
  const patch: UpdateSpeakerPatchType = {
    name: name.trim(),
    images,
    shortDescription: normalizeOptionalPatchString(shortDescription),
    description: normalizeOptionalPatchString(description),
  };

  return {
    speakerId,
    patch,
    ...(createSpeakerList ? { createSpeakerList: true } : {}),
    ...(deleteAssociatedList ? { deleteAssociatedList: true } : {}),
  };
};
