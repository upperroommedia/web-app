
export type SubsplashMediaType = 
  | 'media-item'
  | 'media-series'
  | 'song'
  | 'link'
  | 'rss'
  | 'list'
  | 'album';

export interface SubsplashResourceLink {
  href: string;
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

export interface SubsplashMediaItem {
  id: string;
  type: SubsplashMediaType;
}

export interface SubsplashListRowEmbedded {
  'source-list': { id: string };
  'media-item'?: SubsplashEmbedResource;
  'media-series'?: SubsplashEmbedResource;
  'song'?: SubsplashEmbedResource;
  'link'?: SubsplashEmbedResource;
  'rss'?: SubsplashEmbedResource;
  'list'?: SubsplashEmbedResource;
  'album'?: SubsplashEmbedResource;
}

export interface SubsplashListRow {
  id?: string; 
  app_key: string;
  method: 'static';
  position: number;
  type: SubsplashMediaType;
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

// Minimal list-row reference for PATCH operations (existing rows)
export interface SubsplashListRowReference {
  id: string;
  position: number;
}

// For PATCH, we can send either references (existing) or full rows (new)
export type SubsplashListRowPatch = SubsplashListRowReference | SubsplashListRow;

export interface SubsplashPatchPayload {
  id: string;
  _embedded: {
    'display-options'?: Array<{ id: string }>;
    'images'?: Array<{ id: string; type: string }>;
    'list-rows': SubsplashListRowPatch[];
  };
}
