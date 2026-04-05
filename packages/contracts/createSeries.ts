export interface CreateSeriesImageInput {
  id: string;
  type: string;
  downloadLink: string;
  name?: string;
  subsplashId?: string;
}

export interface CreateSeriesInputType {
  title: string;
  summary?: string;
  ownerId: string;
  firestoreId?: string;
  skipSubsplash?: boolean;
  operationKey?: string;
  images?: CreateSeriesImageInput[];
}

export interface CreateSeriesOutputType {
  status: 'success' | 'error';
  firestoreId?: string;
  subsplashId?: string;
  slug?: string;
  error?: string;
}
