import { ImageType } from '@upperroom/shared/types/Image';

export interface CreateNewSubsplashListInputType {
  title: string;
  subtitle?: string;
  images?: ImageType[];
  operationKey?: string;
}

export interface CreateNewSubsplashListOutputType {
  listId: string;
}
