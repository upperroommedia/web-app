import axios from 'axios';
import { createAxiosConfig } from '../subsplashUtils';
import type { SubsplashImage } from '../types/Subsplash';

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

export type SubsplashMediaItemDetails = {
  id: string;
  title?: string;
  subtitle?: string | null;
  summary?: string;
  status?: string;
  date?: string;
  duration?: number;
  position?: number | null;
  tags?: string[];
  audio_url?: string;
  _embedded?: {
    'media-series'?: { id?: string } | null;
    audio?: { id?: string } | null;
    images?: SubsplashImage[];
  };
};

export async function getSubsplashMediaItemDetails(
  mediaItemId: string,
  token: string
): Promise<SubsplashMediaItemDetails> {
  const config = createAxiosConfig(
    `https://core.subsplash.com/media/v1/media-items/${mediaItemId}`,
    token,
    'GET'
  );

  const response = await axios(config);
  return response.data as SubsplashMediaItemDetails;
}

export async function getSubsplashMediaItemDiagnostics(
  mediaItemId: string,
  token: string
): Promise<
  | { found: true; item: SubsplashMediaItemDetails; summary: Record<string, unknown> }
  | { found: false; error: string }
> {
  try {
    const item = await getSubsplashMediaItemDetails(mediaItemId, token);
    return {
      found: true,
      item,
      summary: summarizeSubsplashMediaItemDetails(item) ?? { id: item.id },
    };
  } catch (error) {
    return {
      found: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const summarizeSubsplashMediaItemDetails = (
  item: SubsplashMediaItemDetails | null | undefined
): Record<string, unknown> | undefined => {
  if (!item) {
    return undefined;
  }

  return {
    id: item.id,
    title: normalizeString(item.title),
    status: normalizeString(item.status),
    position: typeof item.position === 'number' ? item.position : item.position ?? undefined,
    currentSeriesId: normalizeString(item._embedded?.['media-series']?.id),
    audioId: normalizeString(item._embedded?.audio?.id),
    imageIds: item._embedded?.images?.map((image) => image.id) ?? [],
    tagCount: item.tags?.length ?? 0,
  };
};
