import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { deriveSubsplashStatus } from '../../utils/deriveSubsplashStatus';

describe('deriveSubsplashStatus', () => {
  it('returns NOT_UPLOADED when there are no lists', () => {
    expect(deriveSubsplashStatus(0, 0)).toBe(uploadStatus.NOT_UPLOADED);
  });

  it('returns UPLOADED when all lists are uploaded', () => {
    expect(deriveSubsplashStatus(3, 3)).toBe(uploadStatus.UPLOADED);
  });

  it('returns NOT_UPLOADED when only some lists are uploaded', () => {
    expect(deriveSubsplashStatus(3, 2)).toBe(uploadStatus.NOT_UPLOADED);
  });

  it('clamps invalid negative counts to NOT_UPLOADED', () => {
    expect(deriveSubsplashStatus(-1, -1)).toBe(uploadStatus.NOT_UPLOADED);
  });
});
