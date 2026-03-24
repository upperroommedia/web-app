import { UPLOAD_TO_SUBSPLASH_INCOMING_DATA } from './uploadToSubsplash';

export interface EDIT_SUBSPLASH_SERMON_INCOMING_DATA
  extends Partial<Omit<UPLOAD_TO_SUBSPLASH_INCOMING_DATA, 'audioUrl' | 'autoPublish'>> {
  operationKey: string;
  subsplashId: string;
}
