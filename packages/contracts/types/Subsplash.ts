export type SubsplashMediaType =
  | 'media-item'
  | 'media-series'
  | 'song'
  | 'link'
  | 'rss'
  | 'list'
  | 'album'
  | 'calendar'
  | 'event';

export type SubsplashListRowMethod = 'static' | 'most_recent' | 'next_upcoming';

export interface SubsplashResourceLink {
  href: string;
  templated?: boolean;
}

export interface SubsplashImageLinks {
  self: SubsplashResourceLink;
  related: SubsplashResourceLink;
  download: SubsplashResourceLink;
}

export interface SubsplashImage {
  id: string;
  type: 'wide' | 'square' | 'banner';
  width?: number;
  height?: number;
  average_color_hex?: string;
  vibrant_color_hex?: string;
  content_type?: string;
  _links?: SubsplashImageLinks;
}

export interface SubsplashEmbedResource {
  id: string;
  [key: string]: unknown;
}

export interface SubsplashSourceListReference {
  id: string;
  _links?: {
    self?: SubsplashResourceLink;
    'list-rows'?: SubsplashResourceLink;
    [key: string]: SubsplashResourceLink | undefined;
  };
}

export interface SubsplashMediaItem {
  id: string;
  type: SubsplashMediaType;
}

export interface SubsplashListRowEmbedded {
  'source-list': SubsplashSourceListReference;
  'media-item'?: SubsplashEmbedResource;
  'media-series'?: SubsplashEmbedResource;
  'song'?: SubsplashEmbedResource;
  'link'?: SubsplashEmbedResource;
  'rss'?: SubsplashEmbedResource;
  'list'?: SubsplashEmbedResource;
  'album'?: SubsplashEmbedResource;
  'calendar'?: SubsplashEmbedResource;
  'event'?: SubsplashEmbedResource;
}

export interface SubsplashListRow {
  id?: string;
  _links?: {
    self?: SubsplashResourceLink;
    [key: string]: SubsplashResourceLink | undefined;
  };
  app_key: string;
  method: SubsplashListRowMethod;
  position: number;
  type: SubsplashMediaType;
  created_at?: string;
  updated_at?: string;
  _embedded: SubsplashListRowEmbedded;
}

export interface SubsplashListLinks {
  self: SubsplashResourceLink;
  'list-rows': SubsplashResourceLink;
}

export interface SubsplashListEmbedded {
  'display-options'?: Array<{ id: string }>;
  images?: SubsplashImage[];
  'list-rows'?: SubsplashListRow[];
  [key: string]: unknown;
}

export interface SubsplashList {
  id: string;
  app_key: string;
  title: string;
  subtitle?: string;
  type: string;
  status: string;
  updated_at: string;
  created_at: string;
  list_rows_count: number;
  max_item_count: number;
  _links: SubsplashListLinks;
  _embedded: SubsplashListEmbedded;
}

export interface SubsplashListRowReference {
  id: string;
  position: number;
}

export type SubsplashListRowPatch = SubsplashListRowReference | SubsplashListRow;

export interface SubsplashPatchPayload {
  id: string;
  _embedded: {
    'display-options'?: Array<{ id: string }>;
    images?: Array<{ id: string; type: string }>;
    'list-rows': SubsplashListRowPatch[];
  };
}
