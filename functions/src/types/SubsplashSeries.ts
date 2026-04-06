/**
 * Subsplash Series API Types
 * Based on HAR file analysis of the Subsplash media/v1/media-series endpoints
 */

export interface SubsplashSeriesLinks {
  self: { href: string };
  'media-items': { href: string };
}

export interface SubsplashSeriesImage {
  id: string;
  type: 'square' | 'wide' | 'banner';
}

export interface SubsplashSeriesMediaItemRef {
  id: string;
  position: number | null;
}

export interface SubsplashSeriesEmbedded {
  images?: SubsplashSeriesImage[];
  'media-items'?: SubsplashSeriesMediaItemRef[];
}

/**
 * Subsplash Media Series response object
 */
export interface SubsplashSeries {
  id: string;
  app_key: string;
  title: string;
  subtitle?: string;
  slug: string;
  summary?: string;
  published_at?: string | null;
  media_items_count: number;
  published_media_items_count: number;
  display_type: string;
  status: 'draft' | 'published';
  short_code: string;
  is_default: boolean;
  position: number;
  created_at: string;
  updated_at: string;
  _links: SubsplashSeriesLinks;
  _embedded?: SubsplashSeriesEmbedded;
}

/**
 * Payload for creating a new series
 */
export interface CreateSeriesPayload {
  app_key: string;
  title: string;
  subtitle?: string;
  summary?: string;
}

/**
 * Payload for patching a series (e.g., reordering items)
 */
export interface PatchSeriesPayload {
  id: string;
  title?: string;
  subtitle?: string;
  summary?: string | null;
  published_at?: string | null;
  _embedded?: {
    images?: Array<{ id: string; type: string }>;
    'media-items'?: Array<{ id: string; position: number | null }>;
  };
}

/**
 * Payload for patching a media item to assign/unassign series
 */
export interface PatchMediaItemSeriesPayload {
  id: string;
  app_key: string;
  position?: number;
  _embedded: {
    'media-series': { id: string } | null;
    // Preserve existing embedded resources
    audio?: { id: string };
    images?: Array<{ id: string; type: string }>;
  };
}

/**
 * Media item as returned when querying by series
 */
export interface SubsplashSeriesMediaItem {
  id: string;
  app_key: string;
  title: string;
  position: number | null;
  status: 'draft' | 'published' | 'scheduled';
  created_at: string;
  updated_at: string;
  _embedded?: {
    'media-series'?: { id: string } | null;
    audio?: { id: string };
    images?: Array<{ id: string; type: string }>;
  };
}
