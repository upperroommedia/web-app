import { FunctionOutputType } from '@upperroom/shared/types/Function';
import { DirectoryUser } from '@upperroom/shared/types/User';

export interface ListUsersInputType {
  maxResults?: number;
  pageToken?: string;
}

export type ListUsersOutputType = FunctionOutputType<DirectoryUser[]>;
