import { shouldMirrorPhysicalListItemToRootMembership } from '../../helpers/listOverflowChain';

describe('shouldMirrorPhysicalListItemToRootMembership', () => {
  it('mirrors explicit root lists', () => {
    expect(
      shouldMirrorPhysicalListItemToRootMembership({
        isRootList: true,
        isMoreSermonsList: false,
      })
    ).toBe(true);
  });

  it('does not mirror explicit overflow lists', () => {
    expect(
      shouldMirrorPhysicalListItemToRootMembership({
        isRootList: false,
        isMoreSermonsList: true,
      })
    ).toBe(false);
  });

  it('continues mirroring legacy root lists until metadata backfill is complete', () => {
    expect(
      shouldMirrorPhysicalListItemToRootMembership({
        isRootList: undefined,
        isMoreSermonsList: undefined,
      })
    ).toBe(true);
  });

  it('does not mirror lists explicitly marked non-root even if overflow flag is missing', () => {
    expect(
      shouldMirrorPhysicalListItemToRootMembership({
        isRootList: false,
        isMoreSermonsList: undefined,
      })
    ).toBe(false);
  });
});
