import { DocumentData, FirestoreDataConverter, QueryDocumentSnapshot } from '../firebase/firestore';
import { ImageType } from './Image';
import { List, listConverter } from './List';
import { Series, seriesConverter } from './Series';
import { createEmptySermon, sermonConverter } from './Sermon';
import { Sermon } from './SermonTypes';

interface mediaItems {
  sermon: Sermon;
  series: Series;
  list: List;
  // song: any;
  // link: any;
  // rss: any;
}

export interface ListItem<T extends keyof mediaItems> {
  id: string;
  name: string;
  images: ImageType[];
  updatedAtMillis: number;
  createdAtMillis: number;
  subsplashId?: string;
  type: T;
  mediaItem: mediaItems[T];
}

export const emptyListItem: ListItem<keyof mediaItems> = {
  id: '',
  name: '',
  createdAtMillis: new Date().getTime(),
  updatedAtMillis: new Date().getTime(),
  images: [],
  type: 'sermon',
  mediaItem: createEmptySermon(),
};

export const ListItemConverter: FirestoreDataConverter<ListItem<keyof mediaItems>> = {
  toFirestore: (listItem: ListItem<keyof mediaItems>): ListItem<keyof mediaItems> => {
    // handle converting the media item to the correct firestore type
    switch (listItem.type) {
      case 'sermon':
        listItem.mediaItem = sermonConverter.toFirestore(
          listItem.mediaItem as mediaItems['sermon']
        ) as mediaItems['sermon'];
        break;
      case 'series':
        listItem.mediaItem = seriesConverter.toFirestore(
          listItem.mediaItem as mediaItems['series']
        ) as mediaItems['series'];
        break;
      case 'list':
        listItem.mediaItem = listConverter.toFirestore(listItem.mediaItem as mediaItems['list']) as mediaItems['list'];
        break;
      default:
        break;
    }
    return listItem;
  },

  fromFirestore: (snapshot: QueryDocumentSnapshot<ListItem<keyof mediaItems>>): ListItem<keyof mediaItems> => {
    const listItem = { ...emptyListItem, ...snapshot.data(), id: snapshot.id };

    // handle converting the media item to the correct firestore type
    switch (listItem.type) {
      case 'sermon':
        listItem.mediaItem = sermonConverter.fromFirestore(
          listItem.mediaItem as unknown as QueryDocumentSnapshot<DocumentData>
        ) as mediaItems['sermon'];
        break;
      case 'series':
        listItem.mediaItem = seriesConverter.fromFirestore(
          listItem.mediaItem as unknown as QueryDocumentSnapshot<DocumentData>
        ) as mediaItems['series'];
        break;
      case 'list':
        listItem.mediaItem = listConverter.fromFirestore(
          listItem.mediaItem as unknown as QueryDocumentSnapshot<DocumentData>
        ) as mediaItems['list'];
        break;
      default:
        break;
    }
    return listItem;
  },
};
