import { Timestamp } from 'firebase-admin/firestore';
import { Sermon, sermonStatusType, uploadStatus } from '@upperroom/shared/types/SermonTypes';
import type { ISpeaker } from '@upperroom/shared/types/Speaker';
import type { ImageType } from '@upperroom/shared/types/Image';
import { ListType, OverflowBehavior } from '@upperroom/shared/types/List';
import type { List } from '@upperroom/shared/types/List';
import type { SermonList } from '@upperroom/shared/types/SermonList';
import type { Topic } from '@upperroom/shared/types/Topic';
import type { ListItem, ListItemType } from '@upperroom/shared/types/ListItem';
import type { Series } from '@upperroom/shared/types/Series';
import type { SeriesItem } from '@upperroom/shared/types/SeriesItem';

export interface FirebaseSermon extends Omit<Sermon, 'dateMillis' | 'dateString'> {
  date: Timestamp;
}

export const getDateString = (date: Date) => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}`;
};

export const createEmptySermon = (uploaderId?: string): Sermon => {
  const currentDate = new Date();
  return {
    id: '',
    title: '',
    subtitle: '',
    description: '',
    dateMillis: currentDate.getTime(),
    sourceStartTime: 0,
    trimDurationSeconds: 0,
    durationSeconds: 0,
    speakers: [],
    topics: [],
    dateString: currentDate.toLocaleDateString(),
    status: {
      soundCloud: uploadStatus.NOT_UPLOADED,
      subsplash: uploadStatus.NOT_UPLOADED,
      audioStatus: sermonStatusType.PENDING,
    },
    images: [],
    ...(uploaderId ? { uploaderId } : {}),
    numberOfLists: 0,
    numberOfListsUploadedTo: 0,
    createdAtMillis: currentDate.getTime(),
    editedAtMillis: currentDate.getTime(),
  };
};

export const emptySpeaker: ISpeaker = {
  id: '',
  name: '',
  shortDescription: '',
  description: '',
  sermonCount: 0,
  images: [],
};

export const emptyImage: ImageType = {
  id: '',
  size: 'thumbnail',
  type: 'square',
  height: 0,
  width: 0,
  downloadLink: '',
  name: '',
  dateAddedMillis: new Date().getTime(),
};

export const emptyList: List = {
  id: '',
  name: '',
  count: 0,
  type: ListType.SERIES,
  createdAtMillis: new Date().getTime(),
  updatedAtMillis: new Date().getTime(),
  overflowBehavior: OverflowBehavior.CREATENEWLIST,
  images: [],
};

export const emptySermonList: SermonList = {
  ...emptyList,
  uploadStatus: { status: uploadStatus.NOT_UPLOADED },
};

export const emptyTopic: Topic = {
  id: '',
  title: '',
  itemsCount: 0,
  createdAtMillis: new Date().getTime(),
  updatedAtMillis: new Date().getTime(),
  images: [],
};

export const emptyListItem: ListItem<ListItemType> = {
  id: '',
  name: '',
  position: 0,
  createdAtMillis: new Date().getTime(),
  updatedAtMillis: new Date().getTime(),
  images: [],
  type: 'sermon',
  mediaItem: createEmptySermon(),
};

export const emptySeries: Series = {
  id: '',
  name: '',
  subtitle: '0 part series',
  images: [],
  itemCount: 0,
  publishedItemCount: 0,
  status: 'draft',
  subsplashId: '',
  ownerId: '',
  createdAt: null,
  updatedAt: null,
};

export const emptySeriesItem: SeriesItem = {
  id: '',
  sermonSubsplashId: undefined,
  position: 0,
  addedAt: null,
  publishedToSubsplash: false,
};
