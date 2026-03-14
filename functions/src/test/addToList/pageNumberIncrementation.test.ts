import { OverflowBehavior } from '@upperroom/shared/types/List';
import { 
  subsplashMock,
  TestRequest,
  AddToListHandler
} from './mocks';
import { createListDocument, clearFirestore, getListBySubsplashId } from './firestoreHelpers';
import addToList from '../../addToList';

const addToListHandler = addToList as unknown as AddToListHandler;

describe('addToList - Page Number Incrementation', () => {
  beforeEach(async () => {
    await clearFirestore();
    subsplashMock.reset();
    subsplashMock.maxListSize = 5; // Small size for easier testing
  });

  it('should increment page numbers correctly as overflow lists are created', async () => {
    // Create root list
    const rootListId = 'root-list-1';
    subsplashMock.createList(rootListId, 'Original List', 0, 5);
    
    await createListDocument({
      subsplashId: rootListId,
      title: 'Original List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
    });

    // Fill root list to capacity (5 items)
    for (let i = 1; i <= 5; i++) {
      const mediaItem = { id: `item-${i}`, type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [rootListId],
          mediaItem,
          maxListSize: 5
        }
      };
      await addToListHandler(request);
    }

    // Verify root list is full
    const rootRows = subsplashMock.getListRows(rootListId);
    expect(rootRows.length).toBe(5);

    // Add one more item to trigger overflow - should create Page 1
    const overflowItem1 = { id: 'overflow-item-1', type: 'media-item' as const };
    const request1: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootListId],
        mediaItem: overflowItem1,
        maxListSize: 5
      }
    };
    await addToListHandler(request1);

    // Find the overflow list (Page 1) - it should be linked from root
    const rootRowsAfterOverflow = subsplashMock.getListRows(rootListId);
    const linkRow = rootRowsAfterOverflow.find(r => r.type === 'list');
    expect(linkRow).toBeDefined();
    const page1ListId = linkRow!._embedded.list?.id;
    expect(page1ListId).toBeDefined();

    // Verify Page 1 was created with correct subtitle
    const page1List = subsplashMock.getList(page1ListId!);
    expect(page1List).toBeDefined();
    expect(page1List!.title).toBe('More Original List');
    expect(page1List!.subtitle).toBe('Page 1');

    // Verify Firestore document for Page 1
    const page1Doc = await getListBySubsplashId(page1ListId!);
    expect(page1Doc).toBeDefined();
    expect(page1Doc!.data().isMoreSermonsList).toBe(true);

    // Fill Page 1 to capacity (4 items, since 1 was moved there)
    // We need to add 3 more items to root to push 3 more to Page 1
    for (let i = 2; i <= 4; i++) {
      const mediaItem = { id: `overflow-item-${i}`, type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [rootListId],
          mediaItem,
          maxListSize: 5
        }
      };
      await addToListHandler(request);
    }

    // Verify Page 1 is now full (should have 4 items + 1 link = 5 total)
    const page1Rows = subsplashMock.getListRows(page1ListId!);
    expect(page1Rows.length).toBe(5);

    // Add one more item to root to trigger overflow from Page 1 - should create Page 2
    const overflowItem5 = { id: 'overflow-item-5', type: 'media-item' as const };
    const request2: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootListId],
        mediaItem: overflowItem5,
        maxListSize: 5
      }
    };
    await addToListHandler(request2);

    // Find Page 2 - it should be linked from Page 1
    const page1RowsAfterOverflow = subsplashMock.getListRows(page1ListId!);
    const linkRow2 = page1RowsAfterOverflow.find(r => r.type === 'list');
    expect(linkRow2).toBeDefined();
    const page2ListId = linkRow2!._embedded.list?.id;
    expect(page2ListId).toBeDefined();
    expect(page2ListId).not.toBe(rootListId); // Should be a new list

    // Verify Page 2 was created with correct subtitle
    const page2List = subsplashMock.getList(page2ListId!);
    expect(page2List).toBeDefined();
    expect(page2List!.title).toBe('More Original List');
    expect(page2List!.subtitle).toBe('Page 2');

    // Verify Firestore document for Page 2
    const page2Doc = await getListBySubsplashId(page2ListId!);
    expect(page2Doc).toBeDefined();
    expect(page2Doc!.data().isMoreSermonsList).toBe(true);

    // Fill Page 2 to capacity and create Page 3
    for (let i = 6; i <= 8; i++) {
      const mediaItem = { id: `overflow-item-${i}`, type: 'media-item' as const };
      const request: TestRequest = {
        auth: { token: { role: 'admin' } },
        data: {
          destinationListIds: [rootListId],
          mediaItem,
          maxListSize: 5
        }
      };
      await addToListHandler(request);
    }

    // Add one more to trigger Page 3
    const overflowItem9 = { id: 'overflow-item-9', type: 'media-item' as const };
    const request3: TestRequest = {
      auth: { token: { role: 'admin' } },
      data: {
        destinationListIds: [rootListId],
        mediaItem: overflowItem9,
        maxListSize: 5
      }
    };
    await addToListHandler(request3);

    // Find Page 3
    const page2RowsAfterOverflow = subsplashMock.getListRows(page2ListId!);
    const linkRow3 = page2RowsAfterOverflow.find(r => r.type === 'list');
    expect(linkRow3).toBeDefined();
    const page3ListId = linkRow3!._embedded.list?.id;
    expect(page3ListId).toBeDefined();

    // Verify Page 3 was created with correct subtitle
    const page3List = subsplashMock.getList(page3ListId!);
    expect(page3List).toBeDefined();
    expect(page3List!.title).toBe('More Original List');
    expect(page3List!.subtitle).toBe('Page 3');

    // Summary: We should have Page 1, Page 2, and Page 3 with correct subtitles
    expect(page1List!.subtitle).toBe('Page 1');
    expect(page2List!.subtitle).toBe('Page 2');
    expect(page3List!.subtitle).toBe('Page 3');
  });
});

