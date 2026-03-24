import { OverflowBehavior } from '@upperroom/shared/types/List';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import {
  clearFirestore,
  createListDocument,
  getListBySubsplashId,
} from '../addToList/firestoreHelpers';
import { runListOverflowMetadataBackfill } from '../../helpers/backfillListOverflowMetadata';

const firestore = firebaseAdmin.firestore();

describe('backfillListOverflowMetadata', () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it('plans consistent legacy-chain metadata repairs in dry-run mode without writing', async () => {
    await createListDocument({
      id: 'legacy-root-list',
      subsplashId: 'legacy-root-subsplash',
      title: 'Legacy Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 199,
      moreSermonsRef: 'legacy-overflow-subsplash',
    });
    await createListDocument({
      id: 'legacy-overflow-list',
      subsplashId: 'legacy-overflow-subsplash',
      title: 'Legacy Overflow List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 41,
      isMoreSermonsList: true,
    });

    const result = await runListOverflowMetadataBackfill({
      apply: false,
      firestore,
    });

    expect(result.mode).toBe('dry-run');
    expect(result.chainsScanned).toBe(1);
    expect(result.chainsPlanned).toBe(1);
    expect(result.chainsUpdated).toBe(0);
    expect(result.chainsSkipped).toBe(0);
    expect(result.documentsPlanned).toBe(2);
    expect(result.documentsUpdated).toBe(0);
    expect(result.chains).toHaveLength(1);
    expect(result.chains[0]).toMatchObject({
      rootListId: 'legacy-root-list',
      skipped: false,
      logicalCount: 240,
      updates: [
        {
          firestoreListId: 'legacy-root-list',
          data: {
            isRootList: true,
            isMoreSermonsList: false,
            rootListId: 'legacy-root-list',
            overflowDepth: 0,
            logicalCount: 240,
            hasOverflowPages: true,
          },
        },
        {
          firestoreListId: 'legacy-overflow-list',
          data: {
            isRootList: false,
            isMoreSermonsList: true,
            rootListId: 'legacy-root-list',
            overflowDepth: 1,
            name: 'More Legacy Root List sermons',
          },
        },
      ],
    });

    const rootDoc = await getListBySubsplashId('legacy-root-subsplash');
    const overflowDoc = await getListBySubsplashId('legacy-overflow-subsplash');

    expect(rootDoc?.data()).toMatchObject({
      isMoreSermonsList: false,
    });
    expect(rootDoc?.data().isRootList).toBeUndefined();
    expect(rootDoc?.data().rootListId).toBeUndefined();
    expect(rootDoc?.data().logicalCount).toBeUndefined();
    expect(overflowDoc?.data()).toMatchObject({
      isMoreSermonsList: true,
      name: 'Legacy Overflow List',
    });
    expect(overflowDoc?.data().rootListId).toBeUndefined();
    expect(overflowDoc?.data().overflowDepth).toBeUndefined();
  });

  it('applies explicit metadata, logical totals, and canonical overflow names for a consistent chain', async () => {
    await createListDocument({
      id: 'apply-root-list',
      subsplashId: 'apply-root-subsplash',
      title: 'Apply Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 198,
      moreSermonsRef: 'apply-overflow-subsplash',
    });
    await createListDocument({
      id: 'apply-overflow-list',
      subsplashId: 'apply-overflow-subsplash',
      title: 'Second Page',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 12,
      isMoreSermonsList: true,
    });

    const result = await runListOverflowMetadataBackfill({
      apply: true,
      firestore,
    });

    expect(result.mode).toBe('apply');
    expect(result.chainsScanned).toBe(1);
    expect(result.chainsPlanned).toBe(1);
    expect(result.chainsUpdated).toBe(1);
    expect(result.documentsPlanned).toBe(2);
    expect(result.documentsUpdated).toBe(2);

    const rootDoc = await getListBySubsplashId('apply-root-subsplash');
    const overflowDoc = await getListBySubsplashId('apply-overflow-subsplash');

    expect(rootDoc?.data()).toMatchObject({
      isRootList: true,
      isMoreSermonsList: false,
      rootListId: 'apply-root-list',
      overflowDepth: 0,
      logicalCount: 210,
      hasOverflowPages: true,
      name: 'Apply Root List',
    });
    expect(overflowDoc?.data()).toMatchObject({
      isRootList: false,
      isMoreSermonsList: true,
      rootListId: 'apply-root-list',
      overflowDepth: 1,
      name: 'More Apply Root List sermons',
    });
  });

  it('skips inconsistent chains and reports blocking issue details instead of writing guesses', async () => {
    await createListDocument({
      id: 'broken-root-list',
      subsplashId: 'broken-root-subsplash',
      title: 'Broken Root List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 199,
      moreSermonsRef: 'broken-overflow-subsplash',
      logicalCount: 240,
      hasOverflowPages: true,
      isRootList: true,
      rootListId: 'broken-root-list',
      overflowDepth: 0,
    });
    await createListDocument({
      id: 'broken-overflow-list',
      subsplashId: 'broken-overflow-subsplash',
      title: 'Broken Overflow List',
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      count: 41,
      isMoreSermonsList: true,
      rootListId: 'broken-root-list',
      overflowDepth: 0,
      moreSermonsRef: 'missing-overflow-subsplash',
    });

    const logLines: string[] = [];
    const result = await runListOverflowMetadataBackfill({
      apply: true,
      firestore,
      logger: (message) => logLines.push(message),
    });

    expect(result.mode).toBe('apply');
    expect(result.chainsScanned).toBe(1);
    expect(result.chainsPlanned).toBe(0);
    expect(result.chainsUpdated).toBe(0);
    expect(result.chainsSkipped).toBe(1);
    expect(result.documentsPlanned).toBe(0);
    expect(result.documentsUpdated).toBe(0);
    expect(result.chains).toHaveLength(1);
    expect(result.chains[0].skipped).toBe(true);
    expect(result.chains[0].issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'CHAIN_PARENT_CHILD_MISMATCH',
        'CHAIN_DEPTH_COLLISION',
        'CHAIN_MISSING_LINK_TARGET',
      ])
    );
    expect(logLines.join('\n')).toContain('SKIP broken-root-list');
    expect(logLines.join('\n')).toContain('CHAIN_MISSING_LINK_TARGET');

    const rootDoc = await getListBySubsplashId('broken-root-subsplash');
    const overflowDoc = await getListBySubsplashId('broken-overflow-subsplash');

    expect(rootDoc?.data()).toMatchObject({
      logicalCount: 240,
      hasOverflowPages: true,
      isRootList: true,
    });
    expect(overflowDoc?.data()).toMatchObject({
      rootListId: 'broken-root-list',
      overflowDepth: 0,
      name: 'Broken Overflow List',
    });
  });
});
