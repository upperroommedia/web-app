import { FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase-admin/lib/firestore';
import { createEmptySermon, FirebaseSermon, getDateString } from '../../types/Sermon';
import { Sermon } from '../../types/SermonTypes';
import { emptySpeaker, ISpeaker } from '../../types/Speaker';
import { emptyImage, ImageType } from '../../types/Image';
import { Timestamp } from 'firebase/firestore';
import { emptySeries, Series } from '../../types/Series';
import { emptyList, List } from '../../types/List';

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
      key: snapshot.id,
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

export const firestoreAdminSeriesConverter: FirestoreDataConverter<Series> = {
  toFirestore: (series: Series): Series => {
    return series;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Series>): Series => {
    return { ...emptySeries, ...snapshot.data(), id: snapshot.id };
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
