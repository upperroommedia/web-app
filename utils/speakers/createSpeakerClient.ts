import type {
  CreateSpeakerCallableInputType,
  CreateSpeakerCallableOutputType,
} from '../../functions/src/speakers/createSpeakerTypes';
import type { ImageType } from '../../types/Image';

export const SUBSPLASH_SPEAKER_LIST_LINK =
  'https://dashboard.subsplash.com/-d/#/library/lists/standard/2d040f78-a3e1-447a-b5b3-5e80b608dbc6';

export const SPEAKER_LIST_SUCCESS_INSTRUCTION =
  'Your speaker list was created sucessfully - please following the subsplash link and add the newly created list to the correct location to the speakers list if you want it to appear there in the app.';

export interface BuildCreateSpeakerPayloadInput {
  name: string;
  images: ImageType[];
  sermonCount?: number;
  createSpeakerList?: boolean;
}

export const buildCreateSpeakerPayload = ({
  name,
  images,
  sermonCount,
  createSpeakerList,
}: BuildCreateSpeakerPayloadInput): CreateSpeakerCallableInputType => {
  const payload: CreateSpeakerCallableInputType = {
    speaker: {
      name: name.trim(),
      images,
    },
  };

  if (typeof sermonCount === 'number') {
    payload.speaker.sermonCount = sermonCount;
  }

  if (typeof createSpeakerList === 'boolean') {
    payload.createSpeakerList = createSpeakerList;
  }

  return payload;
};

export const shouldShowSpeakerListSuccess = (
  response: Pick<CreateSpeakerCallableOutputType, 'speakerListCreated'>
): boolean => response.speakerListCreated === true;
