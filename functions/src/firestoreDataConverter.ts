import { DocumentData, FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase-admin/lib/firestore';
import { createEmptySermon, FirebaseSermon, getDateString } from '../../types/Sermon';
import { Sermon } from '../../types/SermonTypes';
import { emptySpeaker, ISpeaker } from '../../types/Speaker';
import { emptyImage, ImageType } from '../../types/Image';
import { Timestamp } from 'firebase/firestore';
import { emptyList, List } from '../../types/List';
import { emptyTopic, Topic } from '../../types/Topic';
import { emptyListItem, ListItem, ListItemType } from '../../types/ListItem';

export const firestoreAdminSermonConverter: FirestoreDataConverter<Sermon> = {
  toFirestore: (sermon: Sermon): FirebaseSermon => {
    return { ...sermon, date: Timestamp.fromMillis(sermon.dateMillis) };
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<FirebaseSermon>): Sermon => {
    const { date, ...data } = snapshot.data();
    return {
      ...createEmptySermon(),
      ...data,
      dateMillis: date.toMillis(),
      dateString: getDateString(date.toDate()),
      id: snapshot.id,
    };
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

export const firestoreAdminListItemConverter: FirestoreDataConverter<ListItem<ListItemType>> = {
  toFirestore: (listItem: ListItem<ListItemType>): ListItem<ListItemType> => {
    // handle converting the media item to the correct firestore type
    switch (listItem.type) {
      case 'sermon':
        listItem.mediaItem = firestoreAdminSermonConverter.toFirestore(listItem.mediaItem as Sermon) as any;
        break;
      case 'list':
        listItem.mediaItem = firestoreAdminListConverter.toFirestore(listItem.mediaItem as List) as any;
        break;
      default:
        break;
    }
    return listItem;
  },

  fromFirestore: (snapshot: QueryDocumentSnapshot<ListItem<ListItemType>>): ListItem<ListItemType> => {
    const listItem = { ...emptyListItem, ...snapshot.data(), id: snapshot.id };

    // handle converting the media item to the correct firestore type
    switch (listItem.type) {
      case 'sermon':
        listItem.mediaItem = firestoreAdminSermonConverter.fromFirestore(
          listItem.mediaItem as unknown as QueryDocumentSnapshot<DocumentData>
        ) as Sermon;
        break;
      case 'list':
        listItem.mediaItem = firestoreAdminListConverter.fromFirestore(
          listItem.mediaItem as unknown as QueryDocumentSnapshot<DocumentData>
        ) as List;
        break;
      default:
        break;
    }
    return listItem;
  },
};
