import { FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase-admin/lib/firestore';
import { createEmptySermon, FirebaseSermon, getDateString } from '../../types/Sermon';
import { Sermon } from '../../types/SermonTypes';
import { ISpeaker } from '../../types/Speaker';
import { ImageType } from '../../types/Image';
import { Timestamp } from 'firebase/firestore';
import { Series } from '../../types/Series';

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
    return { ...snapshot.data(), id: snapshot.id };
  },
};

export const firestoreAdminImagesConverter: FirestoreDataConverter<ImageType> = {
  toFirestore: (image: ImageType): ImageType => {
    return image;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<ImageType>): ImageType => {
    return { ...snapshot.data(), id: snapshot.id };
  },
};

export const firestoreAdminSeriesConverter: FirestoreDataConverter<Series> = {
  toFirestore: (series: Series): Series => {
    return series;
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot<Series>): Series => {
    return { ...snapshot.data(), id: snapshot.id };
  },
};
