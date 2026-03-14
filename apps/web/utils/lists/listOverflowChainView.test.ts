import type { GetListOverflowChainOutputType } from '@upperroom/contracts/getListOverflowChain';
import { buildListOverflowChainView } from './listOverflowChainView';

type TestItem = {
  id: string;
  title: string;
  position?: number;
  createdAtMillis?: number;
  dateMillis?: number;
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
});
