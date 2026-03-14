import { DocumentData, FirestoreDataConverter, QueryDocumentSnapshot, Timestamp } from 'firebase-admin/firestore';
import type { Sermon } from '@upperroom/shared/types/SermonTypes';
import type { ISpeaker } from '@upperroom/shared/types/Speaker';
import type { ImageType } from '@upperroom/shared/types/Image';
import type { List } from '@upperroom/shared/types/List';
import type { SermonList } from '@upperroom/shared/types/SermonList';
import type { Topic } from '@upperroom/shared/types/Topic';
import type { ListItem, ListItemType } from '@upperroom/shared/types/ListItem';
import type { Series } from '@upperroom/shared/types/Series';
import type { SeriesItem } from '@upperroom/shared/types/SeriesItem';
import {
  createEmptySermon,
  FirebaseSermon,
  getDateString,
  emptySpeaker,
  emptyImage,
  emptyList,
  emptySermonList,
  emptyTopic,
  emptyListItem,
  emptySeries,
  emptySeriesItem,
} from './models/defaults';

const toFirebaseSermonData = (sermon: Sermon): FirebaseSermon => ({
  ...sermon,
  date: Timestamp.fromMillis(sermon.dateMillis),
});

const fromFirebaseSermonData = (id: string, firestoreSermon: FirebaseSermon): Sermon => {
  const { date, ...data } = firestoreSermon;
  const currentTime = Timestamp.now();
  return {
    ...createEmptySermon(),
    ...data,
    dateMillis: date?.toMillis() || currentTime.toMillis(),
    dateString: getDateString(date?.toDate() || currentTime.toDate()),
    id,
  };
};

export const firestoreAdminSermonConverter: FirestoreDataConverter<Sermon> = {
  toFirestore: (sermon: Sermon): FirebaseSermon => {
    return toFirebaseSermonData(sermon);
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<FirebaseSermon>): Sermon => {
    return fromFirebaseSermonData(snapshot.id, snapshot.data());
  },
};

export const firestoreAdminSpeakerConverter: FirestoreDataConverter<ISpeaker> = {
  toFirestore: (speaker: ISpeaker): ISpeaker => {
    return speaker;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<ISpeaker>): ISpeaker => {
    return { ...emptySpeaker, ...snapshot.data(), id: snapshot.id };
  },
};

export const firestoreAdminImagesConverter: FirestoreDataConverter<ImageType> = {
  toFirestore: (image: ImageType): ImageType => {
    return image;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<ImageType>): ImageType => {
    return { ...emptyImage, ...snapshot.data(), id: snapshot.id };
  },
};

export const firestoreAdminTopicConverter: FirestoreDataConverter<Topic> = {
  toFirestore: (topic: Topic): Topic => {
    return topic;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Topic>): Topic => {
    return { ...emptyTopic, ...snapshot.data(), id: snapshot.id };
  },
};

export const firestoreAdminListConverter: FirestoreDataConverter<List> = {
  toFirestore: (list: List): List => {
    return list;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<List>): List => {
    return { ...emptyList, ...snapshot.data(), id: snapshot.id };
  },
};

export const firestoreAdminSeriesConverter: FirestoreDataConverter<Series> = {
  toFirestore: (series: Series): Series => {
    return series;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Series>): Series => {
    return { ...emptySeries, ...snapshot.data(), id: snapshot.id };
  },
};
export const firestoreAdminSermonListConverter: FirestoreDataConverter<SermonList> = {
  toFirestore: (sermonList: SermonList): SermonList => {
    return sermonList;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<SermonList>): SermonList => {
    return { ...emptySermonList, ...snapshot.data(), id: snapshot.id };
  },
};

export const firestoreAdminListItemConverter: FirestoreDataConverter<ListItem<ListItemType>, DocumentData> = {
  toFirestore: (listItem: ListItem<ListItemType>): DocumentData => {
    if (listItem.type === 'sermon') {
      return {
        ...listItem,
        mediaItem: toFirebaseSermonData(listItem.mediaItem),
      };
    }
    return {
      ...listItem,
      mediaItem: listItem.mediaItem,
    };
  },

  fromFirestore: (snapshot: QueryDocumentSnapshot<DocumentData>): ListItem<ListItemType> => {
    const data = snapshot.data();
    if (data.type === 'sermon') {
      const mediaItem: FirebaseSermon = data.mediaItem;
      const convertedSermon = fromFirebaseSermonData(mediaItem?.id ?? '', mediaItem);
      return {
        ...emptyListItem,
        ...data,
        id: snapshot.id,
        type: 'sermon',
        mediaItem: convertedSermon,
      };
    }

    const mediaItem: List = data.mediaItem;
    const convertedList: List = {
      ...emptyList,
      ...mediaItem,
      id: mediaItem?.id ?? '',
    };
    return {
      ...emptyListItem,
      ...data,
      id: snapshot.id,
      type: 'list',
      mediaItem: convertedList,
    };
  },
};

export const firestoreAdminSeriesItemConverter: FirestoreDataConverter<SeriesItem> = {
  toFirestore: (seriesItem: SeriesItem): SeriesItem => {
    return seriesItem;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<SeriesItem>): SeriesItem => {
    return { ...emptySeriesItem, ...snapshot.data(), id: snapshot.id };
  },
};
