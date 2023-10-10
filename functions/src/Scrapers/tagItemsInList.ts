import axios from 'axios';
import { logger, https } from 'firebase-functions';
import { HttpsError } from 'firebase-functions/v2/https';
import { ListTag, ListType, OverflowBehavior } from '../../../types/List';
import { firestoreAdminListConverter } from '../firestoreDataConverter';
import { ListData, SubsplashListRow } from '../helpers/addToListHelpers';
import { authenticateSubsplash, createAxiosConfig } from '../subsplashUtils';
import firebaseAdmin from '../../../firebase/firebaseAdmin';

interface TAG_ITEMS_IN_LIST_INCOMING_DATA {
  listId: string;
  tag: ListTag;
}

const tagItemsInList = https.onCall(
  async (data: TAG_ITEMS_IN_LIST_INCOMING_DATA, context): Promise<HttpsError | number> => {
    try {
      //gets all sermons
      if (!data.listId) {
        throw new HttpsError('invalid-argument', 'listId is required');
      }
      if (!data.tag) {
        throw new HttpsError('invalid-argument', 'tag is required');
      }
      // check if tag is valid from ListTag enum
      if (!Object.values(ListTag).includes(data.tag)) {
        throw new HttpsError(
          'invalid-argument',
          `tag is invalid, must be one of the following: ${Object.values(ListTag).join(', ')}`
        );
      }

      const token = await authenticateSubsplash();
      const url = `https://core.subsplash.com/builder/v1/list-rows?filter[app_key]=9XTSHD&filter[source_list]=${data.listId}&page[size]=200`;
      const config = createAxiosConfig(url, token, 'GET');
      const response = await axios(config);
      const listRows: SubsplashListRow[] = response.data['_embedded']['list-rows'];

      // for each listRow find the list in firebase and update the tag - if the list does not exist in firebase create it
      const batch = firebaseAdmin.firestore().batch();
      let count = 0;
      await Promise.all(
        listRows.map(async (listRow) => {
          const listId = listRow._embedded.list.id;
          if (!listId) {
            return;
          }
          const embeddedList = listRow._embedded.list as ListData;
          const firestoreLists = firebaseAdmin
            .firestore()
            .collection('lists')
            .withConverter(firestoreAdminListConverter);
          const listRef = firestoreLists.doc(listId);
          const list = await listRef.get();
          if (list.exists) {
            logger.log(`Updating list: ${listId}`);
            batch.update(listRef, {
              listTagAndPosition: { listTag: data.tag, position: listRow.position },
            });
            count++;
          } else {
            logger.log(`Creating list: ${listId}`);
            batch.set(
              firestoreLists.doc(listId),
              {
                id: listId,
                subsplashId: listId,
                name: embeddedList.title,
                count: embeddedList.list_rows_count,
                overflowBehavior: OverflowBehavior.CREATENEWLIST,
                type: ListType.SERIES,
                createdAtMillis:
                  new Date(listRow.created_at).getTime() ||
                  new Date(listRow.updated_at).getTime() ||
                  new Date().getTime(),
                updatedAtMillis:
                  new Date(listRow.updated_at).getTime() ||
                  new Date(listRow.created_at).getTime() ||
                  new Date().getTime(),
                listTagAndPosition: { listTag: data.tag, position: listRow.position },
              },
              { merge: true }
            );
            count++;
          }
          if (count > 0 && count % 500 === 0) {
            batch.commit();
          }
        })
      );

      batch.commit();

      return count;
    } catch (error) {
      const httpsError = new HttpsError('unknown', `${error}`);
      logger.error(httpsError);
      throw httpsError;
    }
  }
);
export default tagItemsInList;
