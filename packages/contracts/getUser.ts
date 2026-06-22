import { FunctionOutputType } from '@upperroom/shared/types/Function';
import { DirectoryUser } from '@upperroom/shared/types/User';

export interface GetUserInputType {
  uid: string;
}

export type GetUserOutputType = FunctionOutputType<DirectoryUser>;
