import { Sermon } from '../../context/types';

export interface GetSermonParams {
  userId: string | undefined;
}

export interface GetSermonsResponse {
  sermons: Sermon[];
}
