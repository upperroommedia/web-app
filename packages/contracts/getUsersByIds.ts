import { FunctionOutputType } from '@upperroom/shared/types/Function';
import { User } from '@upperroom/shared/types/User';

export interface GetUsersByIdsInputType {
  uids: string[];
}

export type GetUsersByIdsOutputType = FunctionOutputType<User[]>;
