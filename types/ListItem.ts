import { DocumentData, FirestoreDataConverter, QueryDocumentSnapshot } from 'firebase/firestore';
import { ImageType } from './Image';
import { List, listConverter } from './List';
import { createEmptySermon, sermonConverter } from './Sermon';
import { Sermon } from './SermonTypes';

export type ListItemType = Sermon | List;

interface CommonFields {
  id: string;
  position: number;
  name: string;
  images: ImageType[];
  updatedAtMillis: number;
  createdAtMillis: number;
  subsplashId?: string;
}

export type ListItem<T extends ListItemType> = CommonFields &
  (T extends Sermon
    ? { type: 'sermon'; mediaItem: Sermon }
    : T extends List
    ? { type: 'list'; mediaItem: List }
    : never);

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

export const ListItemConverter: FirestoreDataConverter<ListItem<ListItemType>> = {
  toFirestore: (listItem: ListItem<ListItemType>): ListItem<ListItemType> => {
    // handle converting the media item to the correct firestore type
    switch (listItem.type) {
      case 'sermon':
        listItem.mediaItem = sermonConverter.toFirestore(listItem.mediaItem as Sermon) as any;
        break;
      case 'list':
        listItem.mediaItem = listConverter.toFirestore(listItem.mediaItem as List) as any;
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
        listItem.mediaItem = sermonConverter.fromFirestore(
          listItem.mediaItem as unknown as QueryDocumentSnapshot<DocumentData>
        ) as Sermon;
        break;
      case 'list':
        listItem.mediaItem = listConverter.fromFirestore(
          listItem.mediaItem as unknown as QueryDocumentSnapshot<DocumentData>
        ) as List;
        break;
      default:
        break;
    }
    return listItem;
  },
};
