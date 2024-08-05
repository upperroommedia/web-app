import admin from 'firebase-admin';
import { createEmptySermon, FirebaseSermon, getDateString } from '../../types/Sermon';
import { Sermon } from '../../types/SermonTypes';
import { emptySpeaker, ISpeaker } from '../../types/Speaker';
import { emptyImage, ImageType } from '../../types/Image';
import { emptyList, List } from '../../types/List';
import { emptySermonList, SermonList } from '../../types/SermonList';
import { emptyTopic, Topic } from '../../types/Topic';
import { emptyListItem, ListItem, ListItemType } from '../../types/ListItem';

export const firestoreAdminSermonConverter: admin.firestore.FirestoreDataConverter<Sermon> = {
  toFirestore: (sermon: Sermon): FirebaseSermon => {
    return { ...sermon, date: admin.firestore.Timestamp.fromMillis(sermon.dateMillis) };
  },
  fromFirestore: (snapshot: admin.firestore.QueryDocumentSnapshot<FirebaseSermon>): Sermon => {
    const { date, ...data } = snapshot.data();
    const currentTime = admin.firestore.Timestamp.now();
    return {
      ...createEmptySermon(),
      ...data,
      dateMillis: date?.toMillis() || currentTime.toMillis(),
      dateString: getDateString(date?.toDate() || currentTime.toDate()),
      id: snapshot.id,
    };
  },
};

export const firestoreAdminSpeakerConverter: admin.firestore.FirestoreDataConverter<ISpeaker> = {
  toFirestore: (speaker: ISpeaker): ISpeaker => {
    return speaker;
  },
  fromFirestore: (snapshot: admin.firestore.QueryDocumentSnapshot<ISpeaker>): ISpeaker => {
    return { ...emptySpeaker, ...snapshot.data(), id: snapshot.id };
  },
};

export const firestoreAdminImagesConverter: admin.firestore.FirestoreDataConverter<ImageType> = {
  toFirestore: (image: ImageType): ImageType => {
    return image;
  },
  fromFirestore: (snapshot: admin.firestore.QueryDocumentSnapshot<ImageType>): ImageType => {
    return { ...emptyImage, ...snapshot.data(), id: snapshot.id };
  },
};

export const firestoreAdminTopicConverter: admin.firestore.FirestoreDataConverter<Topic> = {
  toFirestore: (topic: Topic): Topic => {
    return topic;
  },
  fromFirestore: (snapshot: admin.firestore.QueryDocumentSnapshot<Topic>): Topic => {
    return { ...emptyTopic, ...snapshot.data(), id: snapshot.id };
  },
};

export const firestoreAdminListConverter: admin.firestore.FirestoreDataConverter<List> = {
  toFirestore: (list: List): List => {
    return list;
  },
  fromFirestore: (snapshot: admin.firestore.QueryDocumentSnapshot<List>): List => {
    return { ...emptyList, ...snapshot.data(), id: snapshot.id };
  },
};
export const firestoreAdminSermonListConverter: admin.firestore.FirestoreDataConverter<SermonList> = {
  toFirestore: (sermonList: SermonList): SermonList => {
    return sermonList;
  },
  fromFirestore: (snapshot: admin.firestore.QueryDocumentSnapshot<SermonList>): SermonList => {
    return { ...emptySermonList, ...snapshot.data(), id: snapshot.id };
  },
};

export const firestoreAdminListItemConverter: admin.firestore.FirestoreDataConverter<ListItem<ListItemType>> = {
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

  fromFirestore: (snapshot: admin.firestore.QueryDocumentSnapshot<ListItem<ListItemType>>): ListItem<ListItemType> => {
    const listItem = { ...emptyListItem, ...snapshot.data(), id: snapshot.id };

    // handle converting the media item to the correct firestore type
    switch (listItem.type) {
      case 'sermon':
        listItem.mediaItem = firestoreAdminSermonConverter.fromFirestore(
          listItem.mediaItem as unknown as admin.firestore.QueryDocumentSnapshot<admin.firestore.DocumentData>
        ) as Sermon;
        break;
      case 'list':
        listItem.mediaItem = firestoreAdminListConverter.fromFirestore(
          listItem.mediaItem as unknown as admin.firestore.QueryDocumentSnapshot<admin.firestore.DocumentData>
        ) as List;
        break;
      default:
        break;
    }
    return listItem;
  },
};
