import type { SearchClient, SearchResponse } from 'algoliasearch';
import type { Order } from '../../context/types';
import { ListType, OverflowBehavior, type List } from '../../types/List';
import type { ImageType } from '../../types/Image';
import type { ISpeaker } from '../../types/Speaker';
import type { Sermon, sermonStatus } from '../../types/SermonTypes';
import { sermonStatusType, uploadStatus } from '../../types/SermonTypes';
import { resolveListIndexName } from './listSorting';
import { resolveSpeakerIndexName } from './speakerSorting';

export interface AlgoliaSermonHit extends Omit<Partial<Sermon>, 'status'> {
  objectID: string;
  speakers?: ISpeaker[];
  images?: ImageType[];
  status?: Partial<sermonStatus>;
}

export interface AlgoliaSpeakerHit extends Partial<ISpeaker> {
  objectID: string;
  nbHits?: number;
}

export interface AlgoliaListHit extends Partial<List> {
  objectID: string;
}

const defaultSermonStatus: sermonStatus = {
  soundCloud: uploadStatus.NOT_UPLOADED,
  subsplash: uploadStatus.NOT_UPLOADED,
  audioStatus: sermonStatusType.PENDING,
};

export const normalizeAlgoliaSermonHit = (hit: AlgoliaSermonHit): Sermon => {
  return {
    id: hit.id || hit.objectID,
    title: hit.title || '',
    description: hit.description || '',
    subtitle: hit.subtitle || '',
    speakers: hit.speakers ?? [],
    dateMillis: hit.dateMillis ?? hit.createdAtMillis ?? 0,
    sourceStartTime: hit.sourceStartTime ?? 0,
    durationSeconds: hit.durationSeconds ?? 0,
    topics: hit.topics ?? [],
    dateString: hit.dateString,
    status: {
      ...defaultSermonStatus,
      ...hit.status,
    },
    images: hit.images ?? [],
    numberOfLists: hit.numberOfLists,
    numberOfListsUploadedTo: hit.numberOfListsUploadedTo,
    subsplashId: hit.subsplashId,
    soundCloudTrackId: hit.soundCloudTrackId,
    soundCloudTrackUrl: hit.soundCloudTrackUrl,
    uploaderId: hit.uploaderId,
    approverId: hit.approverId,
    createdAtMillis: hit.createdAtMillis ?? 0,
    editedAtMillis: hit.editedAtMillis ?? hit.createdAtMillis ?? 0,
    youtubeUrl: hit.youtubeUrl,
    seriesId: hit.seriesId,
    searchPending: hit.searchPending,
    searchIndexedAtMillis: hit.searchIndexedAtMillis,
    searchSyncError: hit.searchSyncError,
    uploaderDisplayName: hit.uploaderDisplayName,
    uploaderEmail: hit.uploaderEmail,
    seriesName: hit.seriesName,
    seriesImage: hit.seriesImage,
    seriesPublishedToSubsplash: hit.seriesPublishedToSubsplash,
  };
};

export const normalizeAlgoliaSpeakerHit = (hit: AlgoliaSpeakerHit): ISpeaker => {
  return {
    id: hit.id || hit.objectID,
    name: hit.name || '',
    shortDescription: hit.shortDescription || '',
    description: hit.description || '',
    images: hit.images ?? [],
    sermonCount: hit.sermonCount ?? 0,
    listId: hit.listId,
    tagId: hit.tagId,
  };
};

export const normalizeAlgoliaListHit = (hit: AlgoliaListHit): List => {
  return {
    id: hit.id || hit.objectID,
    name: hit.name || '',
    images: hit.images ?? [],
    overflowBehavior: hit.overflowBehavior ?? OverflowBehavior.CREATENEWLIST,
    count: hit.count ?? 0,
    type: hit.type ?? ListType.SERIES,
    updatedAtMillis: hit.updatedAtMillis,
    createdAtMillis: hit.createdAtMillis ?? 0,
    subsplashId: hit.subsplashId,
    moreSermonsRef: hit.moreSermonsRef,
    isMoreSermonsList: hit.isMoreSermonsList,
    listTagAndPosition: hit.listTagAndPosition,
  };
};

export const searchSpeakersIndex = async (
  searchClient: SearchClient,
  {
    query,
    hitsPerPage,
    page,
    sortProperty,
    sortOrder,
  }: {
    query: string;
    hitsPerPage: number;
    page: number;
    sortProperty: keyof ISpeaker;
    sortOrder: Order;
  }
): Promise<SearchResponse<AlgoliaSpeakerHit>> => {
  const response = await searchClient.search<AlgoliaSpeakerHit>({
    requests: [
      {
        indexName: resolveSpeakerIndexName(sortProperty, sortOrder),
        query,
        hitsPerPage,
        page,
      },
    ],
  });

  return response.results[0] as SearchResponse<AlgoliaSpeakerHit>;
};

export const searchListsIndex = async (
  searchClient: SearchClient,
  {
    query,
    hitsPerPage,
    page,
    sortProperty,
    sortOrder,
    listType,
  }: {
    query: string;
    hitsPerPage: number;
    page: number;
    sortProperty: keyof List;
    sortOrder: Order;
    listType: ListType | '';
  }
): Promise<SearchResponse<AlgoliaListHit>> => {
  const response = await searchClient.search<AlgoliaListHit>({
    requests: [
      {
        indexName: resolveListIndexName(sortProperty, sortOrder),
        query,
        hitsPerPage,
        page,
        ...(listType ? { facetFilters: [[`type:${listType}`]] } : {}),
        filters: 'NOT isMoreSermonsList:true',
      },
    ],
  });

  return response.results[0] as SearchResponse<AlgoliaListHit>;
};
