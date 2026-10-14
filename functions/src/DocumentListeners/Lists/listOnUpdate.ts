import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import { isEqual } from 'lodash';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { List } from '@upperroom/shared/types/List';
import { canonicalMirrorPatch, reconcileCurrentCanonicalMirrors } from '../currentCanonicalMirrors';
import handleError from '../../handleError';

const listOnUpdate = onDocumentUpdated({ document: 'lists/{listId}', retry: true }, async (event) => {
  const change = event.data;
  const { listId } = event.params;

  if (!change) {
    logger.error('Change object is undefined');
    return;
  }

  logger.log('listOnUpdate triggered for: ', listId);
  const originalList = change.before.data() as List;
  const updatedList = change.after.data() as List;
  const firestore = firebaseAdmin.firestore();

  const {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    count: _countBefore,
    updatedAtMillis: _updatedAtMillisBefore,
    /* eslint-enable @typescript-eslint/no-unused-vars */
    ...originalListNoCountOrUpdatedAt
  } = originalList;
  const {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    count: _countAfter,
    updatedAtMillis: _updatedAtMillisAfter,
    /* eslint-enable @typescript-eslint/no-unused-vars */
    ...updatedListNoCountOrUpdatedAt
  } = updatedList;
  const onlyCountUpdated = isEqual(originalListNoCountOrUpdatedAt, updatedListNoCountOrUpdatedAt);
  logger.debug('Original list: ', originalList);
  logger.debug('Updated list: ', updatedList);
  if (onlyCountUpdated) {
    logger.log(`The count or updatedAtMillis were the only properties that changed for ${listId}. Returning early`);
    return;
  }
  try {
    await reconcileCurrentCanonicalMirrors(firestore, {
      sourcePath: `lists/${listId}`,
      collectionGroup: 'sermonLists',
      id: listId,
      parentCollection: 'sermons',
      project: (canonical, mirror) =>
        canonicalMirrorPatch(canonical, mirror, [
          'subsplashId',
          'moreSermonsRef',
          'manualOverflowRowId',
          'manualOverflowTargetSubsplashId',
          'isMoreSermonsList',
          'isRootList',
          'rootListId',
          'overflowDepth',
          'listTagAndPosition',
          'logicalCount',
          'hasOverflowPages',
          'maxListSize',
        ]),
    });
  } catch (error) {
    throw handleError(error);
  }
});

export default listOnUpdate;
