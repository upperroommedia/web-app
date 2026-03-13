import { ImageType } from '../../../types/Image';
import { ISpeaker } from '../../../types/Speaker';

export interface CreateSpeakerPayloadType {
  name: string;
  images: ImageType[];
  shortDescription?: string;
  description?: string;
}

export interface CreateSpeakerCallableInputType {
  speaker: CreateSpeakerPayloadType;
  createSpeakerList?: boolean;
  associatedListId?: string;
  operationKey?: string;
}

export interface CreateSpeakerCallableOutputType {
  status: 'success';
  speakerId: string;
  speaker: ISpeaker;
  speakerListCreated: boolean;
  listId?: string;
  listSubsplashId?: string;
}

export interface UpdateSpeakerPatchType {
  name?: string;
  images?: ImageType[];
  shortDescription?: string | null;
  description?: string | null;
  associatedListId?: string | null;
}

export interface UpdateSpeakerCallableInputType {
  speakerId: string;
  patch: UpdateSpeakerPatchType;
  createSpeakerList?: boolean;
  deleteAssociatedList?: boolean;
  operationKey?: string;
}

export interface UpdateSpeakerCallableOutputType {
  status: 'success';
  speakerId: string;
  speaker: ISpeaker;
  speakerListCreated: boolean;
  listId?: string;
  listSubsplashId?: string;
}

export interface DeleteSpeakerCallableInputType {
  speakerId: string;
  deleteAssociatedList?: boolean;
  operationKey?: string;
}

export interface DeleteSpeakerCallableOutputType {
  status: 'success';
  speakerId: string;
  tagDeleted: boolean;
  removedFromSermonsCount: number;
  listDeleted: boolean;
  deletedListId?: string;
  deletedSubsplashListId?: string;
}
