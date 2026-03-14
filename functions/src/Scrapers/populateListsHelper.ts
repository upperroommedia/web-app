import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { createAxiosConfig } from '../subsplashUtils';
import { List, ListType, OverflowBehavior } from '@upperroom/shared/types/List';
import { ImageType } from '@upperroom/shared/types/Image';
import populateImages from './populateImagesHelper';
import { Bucket } from '@google-cloud/storage';
import { HttpsError } from 'firebase-functions/v2/https';
import { CollectionReference, Firestore } from 'firebase-admin/firestore';
import { SubsplashImage, SubsplashList } from '../types/Subsplash';
import { buildRootListMetadata } from '../helpers/listOverflowChain';

interface SubsplashCategoriesResponse {
  _embedded: {
    'list-rows': Array<{
      _embedded: {
        list: {
          id: string;
          title: string;
        };
      };
    }>;
  };
}

type SubsplashListWithImages = Omit<SubsplashList, '_embedded'> & {
  _embedded: {
    images: SubsplashImage[];
  };
};

interface SubsplashListsResponse {
  count: number;
  total: number;
  _embedded: {
    lists: SubsplashListWithImages[];
  };
}

async function updateCategories(db: Firestore, bearerToken: string, firestoreLists: CollectionReference<List>) {
  // update categories lists from subsplash categories list
  const categoriesResponse: SubsplashCategoriesResponse = (
    await axios(
      createAxiosConfig(
        'https://core.subsplash.com/builder/v1/list-rows?filter%5Bapp_key%5D=9XTSHD&filter%5Bsource_list%5D=c305f7c7-f299-4db9-bf4a-936e79061739&include=images&page%5Bnumber%5D=1&page%5Bsize%5D=100&sort=position',
        bearerToken,
        'GET',
        undefined
      )
    )
  ).data;
  const listRows = categoriesResponse._embedded['list-rows'];
  const batch = db.batch();
  listRows.forEach((listRow) => {
    const listId = listRow._embedded.list.id;
    if (!listId) {
      throw new Error("ListId for category doesn't exist");
    }
    logger.log(`Updating list ${listId} to be a category list - ${listRow._embedded.list.title}`);
    batch.update(firestoreLists.doc(listId), { type: ListType.CATEGORY_LIST });
  });

  // update latest list
  batch.update(firestoreLists.doc('7b7d3fc9-8600-4ec0-b3d1-eed79c0a2ac6'), {
    type: ListType.LATEST,
    overflowBehavior: OverflowBehavior.REMOVEOLDEST,
  });

  await batch.commit();
}

async function populateLists(
  db: Firestore,
  bucket: Bucket,
  bearerToken: string,
  imageIds: Set<string>,
  firestoreImagesMap: Map<string, ImageType>,
  listIdToImageIdMap: Map<string, string[]>,
  listNameToId: Map<string, string>,
  firestoreLists: CollectionReference<List>
): Promise<number> {
  const pageSize = 250; // must be <= 500
  let loop = true;
  let current = 0;
  let pageNumber = 1;
  console.time('Write Lists To Firestore');

  if (pageSize > 500) {
    throw new HttpsError('internal', `List page size must be <= 500. Current value is: ${pageSize}`);
  }
  while (loop) {
    logger.log(`Getting Lists for page ${pageNumber}`);
    const listResponse: SubsplashListsResponse = (
      await axios(
        createAxiosConfig(
          `https://core.subsplash.com/builder/v1/lists?filter%5Bapp_key%5D=9XTSHD&filter%5Bgenerated%5D=false&filter%5Btype%5D=standard&page%5Bnumber%5D=${pageNumber}&page%5Bsize%5D=${pageSize}&sort=title`,
          bearerToken,
          'GET',
          undefined
        )
      )
    ).data;
    current += listResponse.count;
    logger.log(`Retrieved ${current} of ${listResponse.total} speaker tags`);
    pageNumber += 1;
    if (current >= listResponse.total) {
      loop = false;
    }
    logger.log(`Found ${listResponse._embedded.lists.length} lists`);

    const allSubsplashListImages = new Map<string, { imageName: string; image: SubsplashImage }>();

    listResponse._embedded.lists.forEach((list) => {
      if (list._embedded) {
        const subsplashImages = list._embedded.images;
        subsplashImages.forEach((image) => {
          if (image.id) {
            allSubsplashListImages.set(image.id, { imageName: list.title, image });
          }
        });
      }
    });

    const subsplashImagesInput: { imageName: string; image: SubsplashImage }[] = [];
    allSubsplashListImages.forEach((value) => subsplashImagesInput.push(value));

    await populateImages(bucket, imageIds, db, subsplashImagesInput, firestoreImagesMap);

    logger.log(`${firestoreImagesMap.size} images metadata in memory`);

    const batch = db.batch();
    listResponse._embedded.lists.forEach((list, index: number) => {
      if (list.status === 'published' && list.list_rows_count > 0) {
        let images: ImageType[] = [];
        if (list._embedded) {
          images = list._embedded.images
            .map((image) => firestoreImagesMap.get(image.id))
            .filter((image): image is ImageType => image !== undefined);

          listIdToImageIdMap.set(
            list.id,
            images.map((image) => image.id)
          );
        }
        batch.set(
          firestoreLists.doc(list.id),
          {
            id: list.id,
            subsplashId: list.id,
            name: list.title,
            count: list.list_rows_count,
            ...buildRootListMetadata({
              rootListId: list.id,
              logicalCount: list.list_rows_count,
              hasOverflowPages: false,
            }),
            overflowBehavior: OverflowBehavior.CREATENEWLIST,
            type: ListType.SERIES,
            createdAtMillis:
              new Date(list.created_at).getTime() || new Date(list.updated_at).getTime() || new Date().getTime(),
            updatedAtMillis:
              new Date(list.updated_at).getTime() || new Date(list.created_at).getTime() || new Date().getTime(),
            ...(images && { images: images }),
          },
          { merge: true }
        );
        listNameToId.set(list.title, list.id);
        logger.log(
          `Adding list: [${current - listResponse.count + 1 + index}/${listResponse.total}] ${
            list.title
          } to lists collection`
        );
      }
    });
    await batch.commit();
  }
  await updateCategories(db, bearerToken, firestoreLists);
  console.timeEnd('Write Lists To Firestore');
  logger.log(`There are ${listNameToId.size} unique lists`);
  return current;
}

export default populateLists;
