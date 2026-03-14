import { FunctionOutputType } from '@upperroom/shared/types/Function';

export interface SetUserRoleInputType {
  uid: string;
  role: string;
}

export type SetUserRoleOutputType = FunctionOutputType<'success'>;
