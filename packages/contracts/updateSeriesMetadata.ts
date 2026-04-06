export interface UpdateSeriesMetadataImageInput {
  id: string;
  type: string;
  downloadLink?: string;
  name?: string;
  subsplashId?: string;
}

export interface UpdateSeriesMetadataInputType {
  firestoreId: string;
  title: string;
  summary?: string | null;
  images?: UpdateSeriesMetadataImageInput[];
  operationKey?: string;
}

export interface UpdateSeriesMetadataOutputType {
  status: 'success' | 'error';
  firestoreId: string;
  subsplashId: string;
  title: string;
  subtitle: string;
  summary?: string;
  images: UpdateSeriesMetadataImageInput[];
  remoteStatus: 'draft' | 'published';
  slug?: string;
  shortCode?: string;
  position?: number;
  error?: string;
}
