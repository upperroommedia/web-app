import { UploadToSoundCloudInputType } from './uploadToSoundCloud';

export interface EDIT_SOUNDCLOUD_SERMON_INCOMING_DATA
  extends Partial<Omit<UploadToSoundCloudInputType, 'audioStoragePath'>> {
  trackId: string;
}

export interface EditSoundCloudSermonReturnType {
  soundCloudTrackUrl?: string;
}
