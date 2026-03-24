import type { GetListOverflowChainOutputType } from '@upperroom/contracts/getListOverflowChain';
import { buildListOverflowChainView } from './listOverflowChainView';

type TestItem = {
  id: string;
  title: string;
  position?: number;
  createdAtMillis?: number;
  dateMillis?: number;
  physicalPlacement?: {
    firestoreListId?: string;
    subsplashId?: string;
    overflowDepth?: number;
    position?: number;
  };
};

const buildChain = (overrides: Partial<GetListOverflowChainOutputType> = {}): GetListOverflowChainOutputType => ({
  requestedListId: 'root-list',
  rootListId: 'root-list',
  redirectListId: 'root-list',
  logicalCount: 4,
  canMutate: true,
  issues: [],
  nodes: [
    {
      firestoreListId: 'root-list',
      subsplashId: 'subsplash-root',
      name: 'Root List',
      depth: 0,
      count: 2,
      isRoot: true,
      parentFirestoreListId: null,
      nextSubsplashListId: 'subsplash-overflow',
    },
    {
      firestoreListId: 'overflow-list',
      subsplashId: 'subsplash-overflow',
      name: 'More Root List sermons',
      depth: 1,
      count: 2,
      isRoot: false,
      parentFirestoreListId: 'root-list',
      nextSubsplashListId: null,
    },
  ],
  ...overrides,
});

describe('buildListOverflowChainView', () => {
  it('builds one logical list with boundary markers between overflow pages', () => {
    const view = buildListOverflowChainView<TestItem>(buildChain(), {
      'root-list': [
        { id: 'sermon-b', title: 'B', position: 2 },
        { id: 'sermon-a', title: 'A', position: 1 },
      ],
      'overflow-list': [
        { id: 'sermon-d', title: 'D', position: 2 },
        { id: 'sermon-c', title: 'C', position: 1 },
      ],
    });

    expect(view.items.map((item) => item.id)).toEqual(['sermon-a', 'sermon-b', 'sermon-c', 'sermon-d']);
    expect(view.items.map((item) => item.logicalPosition)).toEqual([1, 2, 3, 4]);
    expect(view.boundaryMarkers).toEqual([
      expect.objectContaining({
        sourceListId: 'overflow-list',
        beforeItemId: 'sermon-c',
        sourceDepth: 1,
        localCount: 2,
        physicalCount: 2,
      }),
    ]);
    expect(view.canSaveOrder).toBe(true);
    expect(view.isReadOnly).toBe(false);
  });

  it('degrades to read-only when local mirror coverage does not match the physical chain', () => {
    const view = buildListOverflowChainView<TestItem>(buildChain(), {
      'root-list': [
        { id: 'sermon-a', title: 'A', position: 1 },
        { id: 'sermon-b', title: 'B', position: 2 },
      ],
      'overflow-list': [{ id: 'sermon-c', title: 'C', position: 1 }],
    });

    expect(view.hasCoverageGap).toBe(true);
    expect(view.canSaveOrder).toBe(false);
    expect(view.isReadOnly).toBe(true);
    expect(view.warningMessage).toContain('read-only');
    expect(view.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          firestoreListId: 'overflow-list',
          localCount: 1,
          physicalCount: 2,
          missingMirroredCount: 1,
        }),
      ])
    );
    expect(view.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'LOCAL_MIRROR_GAP',
          severity: 'warning',
        }),
      ])
    );
  });

  it('treats root logical projection coverage as sufficient when it covers the full logical chain', () => {
    const view = buildListOverflowChainView<TestItem>(buildChain(), {
      'root-list': [
        { id: 'sermon-a', title: 'A', position: 1 },
        { id: 'sermon-b', title: 'B', position: 2 },
        { id: 'sermon-c', title: 'C', position: 3 },
        { id: 'sermon-d', title: 'D', position: 4 },
      ],
    });

    expect(view.hasCoverageGap).toBe(false);
    expect(view.canSaveOrder).toBe(true);
    expect(view.items.map((item) => item.id)).toEqual(['sermon-a', 'sermon-b', 'sermon-c', 'sermon-d']);
    expect(view.boundaryMarkers).toEqual([
      expect.objectContaining({
        sourceListId: 'overflow-list',
        beforeItemId: 'sermon-c',
        localCount: 2,
        physicalCount: 2,
      }),
    ]);
  });

  it('uses physical placement from the root logical projection to place boundaries', () => {
    const view = buildListOverflowChainView<TestItem>(buildChain(), {
      'root-list': [
        {
          id: 'sermon-a',
          title: 'A',
          position: 1,
          physicalPlacement: { firestoreListId: 'overflow-list', overflowDepth: 1, position: 1 },
        },
        {
          id: 'sermon-b',
          title: 'B',
          position: 2,
          physicalPlacement: { firestoreListId: 'root-list', overflowDepth: 0, position: 1 },
        },
        {
          id: 'sermon-c',
          title: 'C',
          position: 3,
          physicalPlacement: { firestoreListId: 'root-list', overflowDepth: 0, position: 2 },
        },
        {
          id: 'sermon-d',
          title: 'D',
          position: 4,
          physicalPlacement: { firestoreListId: 'overflow-list', overflowDepth: 1, position: 2 },
        },
      ],
    });

    expect(view.items.map((item) => [item.id, item.sourceListId])).toEqual([
      ['sermon-a', 'overflow-list'],
      ['sermon-b', 'root-list'],
      ['sermon-c', 'root-list'],
      ['sermon-d', 'overflow-list'],
    ]);
    expect(view.boundaryMarkers).toEqual([
      expect.objectContaining({ beforeItemId: 'sermon-d', sourceListId: 'overflow-list' }),
    ]);
    expect(view.canSaveOrder).toBe(true);
  });

  it('uses remote coverage to keep the logical chain mutable even when local mirrors are sparse', () => {
    const view = buildListOverflowChainView<TestItem>(
      buildChain({
        remoteItems: [
          {
            rowId: 'row-a',
            rowType: 'media-item',
            rowMethod: 'static',
            logicalPosition: 1,
            isTrackedInFirebase: false,
            isSubsplashOnlyPlaceholder: true,
            reconstructible: true,
            canEdit: false,
            canDelete: false,
            canRemove: true,
            placement: {
              firestoreListId: 'root-list',
              subsplashListId: 'subsplash-root',
              overflowDepth: 0,
              position: 1,
            },
          },
          {
            rowId: 'row-b',
            rowType: 'media-item',
            rowMethod: 'static',
            logicalPosition: 2,
            isTrackedInFirebase: true,
            isSubsplashOnlyPlaceholder: false,
            reconstructible: true,
            canEdit: true,
            canDelete: true,
            canRemove: true,
            placement: {
              firestoreListId: 'root-list',
              subsplashListId: 'subsplash-root',
              overflowDepth: 0,
              position: 2,
            },
          },
          {
            rowId: 'row-c',
            rowType: 'media-item',
            rowMethod: 'static',
            logicalPosition: 3,
            isTrackedInFirebase: false,
            isSubsplashOnlyPlaceholder: true,
            reconstructible: true,
            canEdit: false,
            canDelete: false,
            canRemove: true,
            placement: {
              firestoreListId: 'overflow-list',
              subsplashListId: 'subsplash-overflow',
              overflowDepth: 1,
              position: 1,
            },
          },
          {
            rowId: 'row-d',
            rowType: 'media-item',
            rowMethod: 'static',
            logicalPosition: 4,
            isTrackedInFirebase: false,
            isSubsplashOnlyPlaceholder: true,
            reconstructible: true,
            canEdit: false,
            canDelete: false,
            canRemove: true,
            placement: {
              firestoreListId: 'overflow-list',
              subsplashListId: 'subsplash-overflow',
              overflowDepth: 1,
              position: 2,
            },
          },
        ],
      }),
      {
        'root-list': [
          { id: 'remote-row-a', title: 'A', position: 1 },
          {
            id: 'remote-row-b',
            title: 'B',
            position: 2,
            physicalPlacement: { firestoreListId: 'root-list', overflowDepth: 0, position: 2 },
          },
          {
            id: 'remote-row-c',
            title: 'C',
            position: 3,
            physicalPlacement: { firestoreListId: 'overflow-list', overflowDepth: 1, position: 1 },
          },
          {
            id: 'remote-row-d',
            title: 'D',
            position: 4,
            physicalPlacement: { firestoreListId: 'overflow-list', overflowDepth: 1, position: 2 },
          },
        ],
      }
    );

    expect(view.hasCoverageGap).toBe(false);
    expect(view.canSaveOrder).toBe(true);
    expect(view.warningMessage).toBeUndefined();
  });

  it('trusts the fetched remote row count over stale logicalCount metadata', () => {
    const view = buildListOverflowChainView<TestItem>(
      buildChain({
        logicalCount: 5,
        remoteItems: [
          {
            rowId: 'row-a',
            rowType: 'media-item',
            rowMethod: 'static',
            logicalPosition: 1,
            isTrackedInFirebase: false,
            isSubsplashOnlyPlaceholder: true,
            reconstructible: true,
            canEdit: false,
            canDelete: false,
            canRemove: true,
            placement: {
              firestoreListId: 'root-list',
              subsplashListId: 'subsplash-root',
              overflowDepth: 0,
              position: 1,
            },
          },
          {
            rowId: 'row-b',
            rowType: 'media-item',
            rowMethod: 'static',
            logicalPosition: 2,
            isTrackedInFirebase: false,
            isSubsplashOnlyPlaceholder: true,
            reconstructible: true,
            canEdit: false,
            canDelete: false,
            canRemove: true,
            placement: {
              firestoreListId: 'root-list',
              subsplashListId: 'subsplash-root',
              overflowDepth: 0,
              position: 2,
            },
          },
          {
            rowId: 'row-c',
            rowType: 'media-item',
            rowMethod: 'static',
            logicalPosition: 3,
            isTrackedInFirebase: false,
            isSubsplashOnlyPlaceholder: true,
            reconstructible: true,
            canEdit: false,
            canDelete: false,
            canRemove: true,
            placement: {
              firestoreListId: 'overflow-list',
              subsplashListId: 'subsplash-overflow',
              overflowDepth: 1,
              position: 1,
            },
          },
          {
            rowId: 'row-d',
            rowType: 'media-item',
            rowMethod: 'static',
            logicalPosition: 4,
            isTrackedInFirebase: false,
            isSubsplashOnlyPlaceholder: true,
            reconstructible: true,
            canEdit: false,
            canDelete: false,
            canRemove: true,
            placement: {
              firestoreListId: 'overflow-list',
              subsplashListId: 'subsplash-overflow',
              overflowDepth: 1,
              position: 2,
            },
          },
        ],
      }),
      {
        'root-list': [
          { id: 'remote-row-a', title: 'A', position: 1 },
          { id: 'remote-row-b', title: 'B', position: 2 },
          {
            id: 'remote-row-c',
            title: 'C',
            position: 3,
            physicalPlacement: { firestoreListId: 'overflow-list', overflowDepth: 1, position: 1 },
          },
          {
            id: 'remote-row-d',
            title: 'D',
            position: 4,
            physicalPlacement: { firestoreListId: 'overflow-list', overflowDepth: 1, position: 2 },
          },
        ],
      }
    );

    expect(view.expectedPhysicalCount).toBe(4);
    expect(view.hasCoverageGap).toBe(false);
    expect(view.canSaveOrder).toBe(true);
  });
});
