import { FunctionOutputType } from '@upperroom/shared/types/Function';
import { User } from '@upperroom/shared/types/User';

export interface GetUserInputType {
  uid: string;
}

export type GetUserOutputType = FunctionOutputType<User>;
