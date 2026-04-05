import axios from 'axios';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  HolyWeekDay,
  HolyWeekKind,
  ListTag,
  ListType,
  OverflowBehavior,
  type List,
} from '@upperroom/shared/types/List';
import type {
  BackfillHolyWeekListsInputType,
  BackfillHolyWeekListsOutputType,
  BackfillHolyWeekListsResultType,
} from '../../packages/contracts/backfillHolyWeekLists';
import { firestoreAdminListConverter } from './firestoreDataConverter';
import handleError from './handleError';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import type { SubsplashImage, SubsplashList, SubsplashListRow } from './types/Subsplash';

const SCRIPT_RUNNER_EMAIL = 'youssef.a.asaad@gmail.com';
const HOLY_WEEK_SOURCE_LIST_ID = '0ac1575c-2508-4c06-882c-b6df30c2bca0';
const PASCHA_WEEK_TITLE_PATTERN = /^Pascha Week (\d{4})$/;

const HOLY_WEEK_DAY_CONFIG: Array<{ day: HolyWeekDay; listId: string; position: number }> = [
  { day: HolyWeekDay.PALM_SUNDAY, listId: '2b21287e-fdc3-42a2-87b5-bd9f33fd2958', position: 1 },
  { day: HolyWeekDay.HOLY_MONDAY, listId: 'b2650da0-0f41-4863-890a-4e572c547b38', position: 2 },
  { day: HolyWeekDay.HOLY_TUESDAY, listId: '65ae89c9-096b-4ba7-84a3-f837dd35c08d', position: 3 },
  { day: HolyWeekDay.HOLY_WEDNESDAY, listId: '27547956-088a-4a71-92d7-1d03968a1353', position: 4 },
  { day: HolyWeekDay.COVENANT_THURSDAY, listId: '87216c9c-7594-4cc2-88a5-30d3c99f96bc', position: 5 },
  { day: HolyWeekDay.GOOD_FRIDAY, listId: '8c1cfe2b-0c88-4d0e-8801-44386ed1755d', position: 6 },
  { day: HolyWeekDay.JOYOUS_SATURDAY, listId: '7cd2e05b-c93f-40be-bd8c-07de09c746b4', position: 7 },
  { day: HolyWeekDay.RESURRECTION, listId: 'dc86bd07-c1ef-40d4-8d0c-9f2c553f6bb1', position: 8 },
];

const getRequesterEmail = (request: CallableRequest<unknown>): string | undefined => {
  const email = request.auth?.token.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : undefined;
};

const assertAuthorizedScriptRunner = async (
  request: CallableRequest<unknown>
): Promise<{ uid: string; email: string }> => {
  const uid = request.auth?.uid;
  const tokenEmail = getRequesterEmail(request);
  if (!uid || tokenEmail !== SCRIPT_RUNNER_EMAIL) {
    throw new HttpsError('permission-denied', 'Only the designated script runner can execute this action.');
  }

  const userRecord = await firebaseAdmin.auth().getUser(uid);
  const canonicalEmail = userRecord.email?.trim().toLowerCase();
  if (canonicalEmail !== SCRIPT_RUNNER_EMAIL || userRecord.emailVerified !== true) {
    throw new HttpsError('permission-denied', 'Only the designated verified script runner can execute this action.');
  }

  return {
    uid,
    email: canonicalEmail,
  };
};

const toImageType = (image: SubsplashImage) => ({
  id: image.id,
  subsplashId: image.id,
  size: 'original' as const,
  type: image.type,
  height: image.height ?? 0,
  width: image.width ?? 0,
  downloadLink: image._links?.related?.href ?? '',
  name: image.id,
  dateAddedMillis: Date.now(),
  averageColorHex: image.average_color_hex,
  vibrantColorHex: image.vibrant_color_hex,
});

const buildFirestoreList = (
  listDetails: SubsplashList,
  listTagAndPosition: List['listTagAndPosition']
): List => {
  const createdAtMillis = listDetails.created_at ? new Date(listDetails.created_at).getTime() : Date.now();
  const updatedAtMillis = listDetails.updated_at ? new Date(listDetails.updated_at).getTime() : createdAtMillis;

  return {
    id: listDetails.id,
    subsplashId: listDetails.id,
    name: listDetails.title || 'Untitled List',
    count: listDetails.list_rows_count || 0,
    overflowBehavior: OverflowBehavior.CREATENEWLIST,
    type: ListType.SERIES,
    createdAtMillis,
    updatedAtMillis,
    images: (listDetails._embedded?.images ?? []).map(toImageType),
    listTagAndPosition,
    isRootList: true,
    rootListId: listDetails.id,
    overflowDepth: 0,
  };
};

const fetchSubsplashList = async (listId: string, token: string): Promise<SubsplashList> => {
  const url = `https://core.subsplash.com/builder/v1/lists/${listId}`;
  const config = createAxiosConfig(url, token, 'GET');
  const response = await axios(config);
  return response.data as SubsplashList;
};

const createEmptyResult = (): BackfillHolyWeekListsResultType => ({
  sourceListId: HOLY_WEEK_SOURCE_LIST_ID,
  totalYearRows: 0,
  createdYearLists: 0,
  updatedYearLists: 0,
  skippedYearLists: 0,
  taggedDayLists: 0,
  duplicateYears: [],
  invalidTitles: [],
  processedYearLists: [],
  processedDayLists: [],
});

const backfillHolyWeekLists = onCall(
  {
    secrets: subsplashSecretsWithRuntimeAlerts,
    timeoutSeconds: 540,
    memory: '512MiB',
    maxInstances: 1,
  },
  async (request: CallableRequest<BackfillHolyWeekListsInputType>): Promise<BackfillHolyWeekListsOutputType> => {
    const requester = await assertAuthorizedScriptRunner(request);

    try {
      const dryRun = request.data?.dryRun === true;
      const token = await authenticateSubsplash();
      const result = createEmptyResult();
      const firestore = firebaseAdmin.firestore();
      const listsCollection = firestore.collection('lists').withConverter(firestoreAdminListConverter);

      const listRowsUrl = `https://core.subsplash.com/builder/v1/list-rows?filter[app_key]=9XTSHD&filter[source_list]=${HOLY_WEEK_SOURCE_LIST_ID}&page[size]=200`;
      const listRowsResponse = await axios(createAxiosConfig(listRowsUrl, token, 'GET'));
      const listRows = (listRowsResponse.data?._embedded?.['list-rows'] ?? []) as SubsplashListRow[];
      result.totalYearRows = listRows.length;

      const yearEntries = listRows.flatMap((row) => {
        const listId = row._embedded?.list?.id;
        if (!listId) {
          return [];
        }

        return [{
          listId,
          position: row.position,
        }];
      });

      const fetchedYearLists = await Promise.all(
        yearEntries.map(async (entry) => {
          const details = await fetchSubsplashList(entry.listId, token);
          return {
            ...entry,
            details,
          };
        })
      );

      const duplicateMap = new Map<number, string[]>();
      const validYearLists: Array<{ listId: string; position: number; year: number; details: SubsplashList }> = [];

      for (const entry of fetchedYearLists) {
        const match = PASCHA_WEEK_TITLE_PATTERN.exec(entry.details.title ?? '');
        if (!match) {
          result.invalidTitles.push({
            listId: entry.listId,
            title: entry.details.title ?? '',
          });
          continue;
        }

        const year = Number.parseInt(match[1], 10);
        const existingIds = duplicateMap.get(year) ?? [];
        duplicateMap.set(year, [...existingIds, entry.listId]);
        validYearLists.push({ ...entry, year });
      }

      result.duplicateYears = Array.from(duplicateMap.entries())
        .filter(([, listIds]) => listIds.length > 1)
        .map(([year, listIds]) => ({ year, listIds }));

      const duplicateYears = new Set(result.duplicateYears.map((entry) => entry.year));
      const uniqueYearLists = validYearLists
        .filter((entry) => !duplicateYears.has(entry.year))
        .sort((first, second) => second.year - first.year);

      let batch = firestore.batch();
      let pendingWrites = 0;
      const commitBatch = async () => {
        if (dryRun || pendingWrites === 0) {
          return;
        }
        await batch.commit();
        batch = firestore.batch();
        pendingWrites = 0;
      };

      for (const entry of uniqueYearLists) {
        const listRef = listsCollection.doc(entry.listId);
        const existingSnapshot = await listRef.get();
        const firestoreList = buildFirestoreList(entry.details, {
          listTag: ListTag.HOLY_WEEK,
          holyWeekKind: HolyWeekKind.YEAR,
          position: entry.position,
          year: entry.year,
        });
        const existingList = existingSnapshot.data();
        const existingTag = existingList?.listTagAndPosition;

        result.processedYearLists.push({
          year: entry.year,
          listId: entry.listId,
          title: entry.details.title,
        });

        if (!existingSnapshot.exists) {
          result.createdYearLists += 1;
        } else if (
          existingTag?.listTag === ListTag.HOLY_WEEK &&
          'holyWeekKind' in existingTag &&
          existingTag.holyWeekKind === HolyWeekKind.YEAR &&
          'year' in existingTag &&
          existingTag.year === entry.year &&
          existingTag.position === entry.position
        ) {
          result.skippedYearLists += 1;
        } else {
          result.updatedYearLists += 1;
        }

        if (!dryRun) {
          batch.set(listRef, firestoreList, { merge: true });
          pendingWrites += 1;
          if (pendingWrites >= 400) {
            await commitBatch();
          }
        }
      }

      for (const dayEntry of HOLY_WEEK_DAY_CONFIG) {
        const listRef = listsCollection.doc(dayEntry.listId);
        const details = await fetchSubsplashList(dayEntry.listId, token);
        const firestoreList = buildFirestoreList(details, {
          listTag: ListTag.HOLY_WEEK,
          holyWeekKind: HolyWeekKind.DAY,
          position: dayEntry.position,
          day: dayEntry.day,
        });

        result.processedDayLists.push({
          day: dayEntry.day,
          listId: dayEntry.listId,
          title: details.title,
        });
        result.taggedDayLists += 1;

        if (!dryRun) {
          batch.set(listRef, firestoreList, { merge: true });
          pendingWrites += 1;
          if (pendingWrites >= 400) {
            await commitBatch();
          }
        }
      }

      await commitBatch();

      logger.log('backfillholyweeklists:complete', {
        requesterEmail: requester.email,
        uid: requester.uid,
        dryRun,
        result,
      });

      return {
        status: 'success',
        data: result,
      };
    } catch (error) {
      throw handleError(error, {
        alertCode: 'HOLY_WEEK_BACKFILL_RUNTIME_FAILURE',
        summary: 'backfillHolyWeekLists failed while syncing Holy Week Firebase list metadata.',
        context: { functionName: 'backfillHolyWeekLists', sourceListId: HOLY_WEEK_SOURCE_LIST_ID },
      });
    }
  }
);

export default backfillHolyWeekLists;
