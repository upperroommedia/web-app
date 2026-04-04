import { uploadStatus } from '@upperroom/shared/types/SermonTypes';

export const deriveSubsplashStatus = (
  numberOfLists: number | undefined,
  numberOfListsUploadedTo: number | undefined
): uploadStatus => {
  const totalLists = Math.max(0, numberOfLists ?? 0);
  const uploadedLists = Math.max(0, numberOfListsUploadedTo ?? 0);

  return totalLists > 0 && uploadedLists === totalLists
    ? uploadStatus.UPLOADED
    : uploadStatus.NOT_UPLOADED;
};
