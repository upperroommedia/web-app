import { ImageType } from '@upperroom/shared/types/Image';

export interface EditSubsplashListInputType {
  listId: string;
  title?: string;
  subtitle?: string;
  images?: ImageType[];
  operationKey?: string;
}

export type EditSubsplashListOutputType = void;
