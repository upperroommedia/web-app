import {
  ListType as AppListType,
  OverflowBehavior as AppOverflowBehavior,
  type List as AppList,
} from '../../../../apps/web/types/List';
import {
  ListType as SharedListType,
  OverflowBehavior as SharedOverflowBehavior,
  type List as SharedList,
} from '@upperroom/shared/types/List';
import type {
  GetListOverflowChainInputType,
  GetListOverflowChainOutputType,
} from '../../../../packages/contracts/getListOverflowChain';

type AssertTrue<T extends true> = T;
type IsAssignable<Left, Right> = Left extends Right ? true : false;

const sharedListMatchesAppList: AssertTrue<IsAssignable<SharedList, AppList>> = true;
const appListMatchesSharedList: AssertTrue<IsAssignable<AppList, SharedList>> = true;
const sharedListTypeMatches: AssertTrue<IsAssignable<SharedListType, AppListType>> = true;
const appListTypeMatches: AssertTrue<IsAssignable<AppListType, SharedListType>> = true;
const sharedOverflowBehaviorMatches: AssertTrue<
  IsAssignable<SharedOverflowBehavior, AppOverflowBehavior>
> = true;
const appOverflowBehaviorMatches: AssertTrue<
  IsAssignable<AppOverflowBehavior, SharedOverflowBehavior>
> = true;

const rootList: SharedList = {
  id: 'root-list',
  name: 'Root List',
  images: [],
  overflowBehavior: SharedOverflowBehavior.CREATENEWLIST,
  type: SharedListType.SERIES,
  createdAtMillis: 1,
  isRootList: true,
  rootListId: 'root-list',
  overflowDepth: 0,
  logicalCount: 240,
  hasOverflowPages: true,
};

const overflowList: AppList = {
  id: 'overflow-list',
  name: 'More Root List sermons',
  images: [],
  overflowBehavior: AppOverflowBehavior.CREATENEWLIST,
  type: AppListType.SERIES,
  createdAtMillis: 1,
  isMoreSermonsList: true,
  isRootList: false,
  rootListId: 'root-list',
  overflowDepth: 1,
};

const request: GetListOverflowChainInputType = {
  listId: rootList.id,
};

const response: GetListOverflowChainOutputType = {
  requestedListId: overflowList.id,
  rootListId: rootList.id,
  redirectListId: rootList.id,
  logicalCount: 240,
  canMutate: false,
  nodes: [
    {
      firestoreListId: rootList.id,
      subsplashId: 'subsplash-root',
      name: rootList.name,
      depth: 0,
      count: 199,
      isRoot: true,
      parentFirestoreListId: null,
      nextSubsplashListId: 'subsplash-overflow',
    },
    {
      firestoreListId: overflowList.id,
      subsplashId: 'subsplash-overflow',
      name: overflowList.name,
      depth: 1,
      count: 41,
      isRoot: false,
      parentFirestoreListId: rootList.id,
      nextSubsplashListId: null,
    },
  ],
  issues: [
    {
      code: 'CHAIN_NAME_DRIFT',
      severity: 'warning',
      message: 'Overflow page name differs from canonical root naming.',
      firestoreListId: overflowList.id,
    },
    {
      code: 'CHAIN_MISSING_LINK_TARGET',
      severity: 'blocking',
      message: 'A chain link points to an overflow page that is not represented in Firestore.',
      firestoreListId: rootList.id,
      subsplashListId: 'subsplash-missing',
    },
  ],
};

void request;
void response;
void sharedListMatchesAppList;
void appListMatchesSharedList;
void sharedListTypeMatches;
void appListTypeMatches;
void sharedOverflowBehaviorMatches;
void appOverflowBehaviorMatches;
