export interface UploadToSoundCloudInputType {
  audioStoragePath: string;
  title: string;
  speakers: string[];
  tags: string[];
  description: string;
  imageSource?: string;
  imageStoragePath?: string;
}

export type UploadToSoundCloudReturnType = {
  soundCloudTrackId: string;
  soundCloudTrackUrl?: string;
};
