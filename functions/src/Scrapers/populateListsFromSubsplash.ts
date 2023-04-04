import axios from 'axios';
import { firestore } from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import { firestoreAdminListConverter } from '../firestoreDataConverter';
import { createAxiosConfig } from '../subsplashUtils';
import { List, ListType, OverflowBehavior } from '../../../types/List';

async function populateListsFromSubsplash(
  db: firestore.Firestore,
  bearerToken: string,
  speakerNameToListId: { [key: string]: string },
  pageSize: number
) {
  const firestoreLists = db.collection('lists').withConverter(firestoreAdminListConverter);

  logger.log('Getting Lists');
  const listResponse = (
    await axios(
      createAxiosConfig(
        `https://core.subsplash.com/builder/v1/lists?filter%5Bapp_key%5D=9XTSHD&filter%5Bgenerated%5D=false&filter%5Btype%5D=standard&page%5Bsize%5D=${pageSize}&sort=title`,
        bearerToken,
        'GET',
        undefined
      )
    )
  ).data;
  console.time('Write Lists To Firestore');
  let batch = db.batch();

  let count = 0;
  const lists = listResponse._embedded.lists;
  const listLength = lists.length;
  logger.log(`Found ${listLength} lists`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  while (lists.length) {
    const list = lists.shift();
    if (list.status === 'published' && list.list_rows_count > 0) {
      const newList: List = {
        id: list.id,
        name: list.title,
        count: list.list_rows_count,
        overflowBehavior: OverflowBehavior.CREATENEWLIST,
        type: ListType.SERIES,
        createdAtMillis: new Date(list.created_at).getTime(),
        updatedAtMillis: new Date(list.updated_at).getTime(),
        images: [],
      };
      batch.set(firestoreLists.doc(list.id), newList, { merge: true });
      speakerNameToListId[list.title] = list.id;
      logger.log(`Adding list: ${list.title} to lists collection`);

      // handle commiting batch when over 500 or end of list
      if (++count >= 500 || !lists.length) {
        await batch.commit();
        batch = db.batch();
        count = 0;
      }
    }
  }
  console.timeEnd('Write Lists To Firestore');
  logger.log(`There are ${listLength - Object.keys(speakerNameToListId).length} unique lists`);
}

export default populateListsFromSubsplash;
